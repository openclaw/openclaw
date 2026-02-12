# Copyright 2016-2018 Julien Danjou
# Copyright 2017 Elisey Zanko
# Copyright 2016 Étienne Bersac
# Copyright 2016 Joshua Harlow
# Copyright 2013-2014 Ray Holder
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


import functools
import sys
import threading
import time
import typing as t
import warnings
from abc import ABC, abstractmethod
from concurrent import futures
from inspect import iscoroutinefunction

# Import all built-in retry strategies for easier usage.
from .retry import retry_base  # noqa
from .retry import retry_all  # noqa
from .retry import retry_always  # noqa
from .retry import retry_any  # noqa
from .retry import retry_if_exception  # noqa
from .retry import retry_if_exception_type  # noqa
from .retry import retry_if_exception_cause_type  # noqa
from .retry import retry_if_not_exception_type  # noqa
from .retry import retry_if_not_result  # noqa
from .retry import retry_if_result  # noqa
from .retry import retry_never  # noqa
from .retry import retry_unless_exception_type  # noqa
from .retry import retry_if_exception_message  # noqa
from .retry import retry_if_not_exception_message  # noqa

# Import all nap strategies for easier usage.
from .nap import sleep  # noqa
from .nap import sleep_using_event  # noqa

# Import all built-in stop strategies for easier usage.
from .stop import stop_after_attempt  # noqa
from .stop import stop_after_delay  # noqa
from .stop import stop_all  # noqa
from .stop import stop_any  # noqa
from .stop import stop_never  # noqa
from .stop import stop_when_event_set  # noqa

# Import all built-in wait strategies for easier usage.
from .wait import wait_chain  # noqa
from .wait import wait_combine  # noqa
from .wait import wait_exponential  # noqa
from .wait import wait_fixed  # noqa
from .wait import wait_incrementing  # noqa
from .wait import wait_none  # noqa
from .wait import wait_random  # noqa
from .wait import wait_random_exponential  # noqa
from .wait import wait_random_exponential as wait_full_jitter  # noqa
from .wait import wait_exponential_jitter  # noqa

# Import all built-in before strategies for easier usage.
from .before import before_log  # noqa
from .before import before_nothing  # noqa

# Import all built-in after strategies for easier usage.
from .after import after_log  # noqa
from .after import after_nothing  # noqa

# Import all built-in after strategies for easier usage.
from .before_sleep import before_sleep_log  # noqa
from .before_sleep import before_sleep_nothing  # noqa

# Replace a conditional import with a hard-coded None so that pip does
# not attempt to use tornado even if it is present in the environment.
# If tornado is non-None, tenacity will attempt to execute some code
# that is sensitive to the version of tornado, which could break pip
# if an old version is found.
tornado = None  # type: ignore

if t.TYPE_CHECKING:
    import types

    from .retry import RetryBaseT
    from .stop import StopBaseT
    from .wait import WaitBaseT


WrappedFnReturnT = t.TypeVar("WrappedFnReturnT")
WrappedFn = t.TypeVar("WrappedFn", bound=t.Callable[..., t.Any])


class TryAgain(Exception):
    """Always retry the executed function when raised."""


NO_RESULT = object()


class DoAttempt:
    pass


class DoSleep(float):
    pass


class BaseAction:
    """Base class for representing actions to take by retry object.

    Concrete implementations must define:
    - __init__: to initialize all necessary fields
    - REPR_FIELDS: class variable specifying attributes to include in repr(self)
    - NAME: for identification in retry object methods and callbacks
    """

    REPR_FIELDS: t.Sequence[str] = ()
    NAME: t.Optional[str] = None

    def __repr__(self) -> str:
        state_str = ", ".join(f"{field}={getattr(self, field)!r}" for field in self.REPR_FIELDS)
        return f"{self.__class__.__name__}({state_str})"

    def __str__(self) -> str:
        return repr(self)


class RetryAction(BaseAction):
    REPR_FIELDS = ("sleep",)
    NAME = "retry"

    def __init__(self, sleep: t.SupportsFloat) -> None:
        self.sleep = float(sleep)


_unset = object()


def _first_set(first: t.Union[t.Any, object], second: t.Any) -> t.Any:
    return second if first is _unset else first


class RetryError(Exception):
    """Encapsulates the last attempt instance right before giving up."""

    def __init__(self, last_attempt: "Future") -> None:
        self.last_attempt = last_attempt
        super().__init__(last_attempt)

    def reraise(self) -> "t.NoReturn":
        if self.last_attempt.failed:
            raise self.last_attempt.result()
        raise self

    def __str__(self) -> str:
        return f"{self.__class__.__name__}[{self.last_attempt}]"


class AttemptManager:
    """Manage attempt context."""

    def __init__(self, retry_state: "RetryCallState"):
        self.retry_state = retry_state

    def __enter__(self) -> None:
        pass

    def __exit__(
        self,
        exc_type: t.Optional[t.Type[BaseException]],
        exc_value: t.Optional[BaseException],
        traceback: t.Optional["types.TracebackType"],
    ) -> t.Optional[bool]:
        if exc_type is not None and exc_value is not None:
            self.retry_state.set_exception((exc_type, exc_value, traceback))
            return True  # Swallow exception.
        else:
            # We don't have the result, actually.
            self.retry_state.set_result(None)
            return None


class BaseRetrying(ABC):
    def __init__(
        self,
        sleep: t.Callable[[t.Union[int, float]], None] = sleep,
        stop: "StopBaseT" = stop_never,
        wait: "WaitBaseT" = wait_none(),
        retry: "RetryBaseT" = retry_if_exception_type(),
        before: t.Callable[["RetryCallState"], None] = before_nothing,
        after: t.Callable[["RetryCallState"], None] = after_nothing,
        before_sleep: t.Optional[t.Callable[["RetryCallState"], None]] = None,
        reraise: bool = False,
        retry_error_cls: t.Type[RetryError] = RetryError,
        retry_error_callback: t.Optional[t.Callable[["RetryCallState"], t.Any]] = None,
    ):
        self.sleep = sleep
        self.stop = stop
        self.wait = wait
        self.retry = retry
        self.before = before
        self.after = after
        self.before_sleep = before_sleep
        self.reraise = reraise
        self._local = threading.local()
        self.retry_error_cls = retry_error_cls
        self.retry_error_callback = retry_error_callback

    def copy(
        self,
        sleep: t.Union[t.Callable[[t.Union[int, float]], None], object] = _unset,
        stop: t.Union["StopBaseT", object] = _unset,
        wait: t.Union["WaitBaseT", object] = _unset,
        retry: t.Union[retry_base, object] = _unset,
        before: t.Union[t.Callable[["RetryCallState"], None], object] = _unset,
        after: t.Union[t.Callable[["RetryCallState"], None], object] = _unset,
        before_sleep: t.Union[t.Optional[t.Callable[["RetryCallState"], None]], object] = _unset,
        reraise: t.Union[bool, object] = _unset,
        retry_error_cls: t.Union[t.Type[RetryError], object] = _unset,
        retry_error_callback: t.Union[t.Optional[t.Callable[["RetryCallState"], t.Any]], object] = _unset,
    ) -> "BaseRetrying":
        """Copy this object with some parameters changed if needed."""
        return self.__class__(
            sleep=_first_set(sleep, self.sleep),
            stop=_first_set(stop, self.stop),
            wait=_first_set(wait, self.wait),
            retry=_first_set(retry, self.retry),
            before=_first_set(before, self.before),
            after=_first_set(after, self.after),
            before_sleep=_first_set(before_sleep, self.before_sleep),
            reraise=_first_set(reraise, self.reraise),
            retry_error_cls=_first_set(retry_error_cls, self.retry_error_cls),
            retry_error_callback=_first_set(retry_error_callback, self.retry_error_callback),
        )

    def __repr__(self) -> str:
        return (
            f"<{self.__class__.__name__} object at 0x{id(self):x} ("
            f"stop={self.stop}, "
            f"wait={self.wait}, "
            f"sleep={self.sleep}, "
            f"retry={self.retry}, "
            f"before={self.before}, "
            f"after={self.after})>"
        )

    @property
    def statistics(self) -> t.Dict[str, t.Any]:
        """Return a dictionary of runtime statistics.

        This dictionary will be empty when the controller has never been
        ran. When it is running or has ran previously it should have (but
        may not) have useful and/or informational keys and values when
        running is underway and/or completed.

        .. warning:: The keys in this dictionary **should** be some what
                     stable (not changing), but there existence **may**
                     change between major releases as new statistics are
                     gathered or removed so before accessing keys ensure that
                     they actually exist and handle when they do not.

        .. note:: The values in this dictionary are local to the thread
                  running call (so if multiple threads share the same retrying
                  object - either directly or indirectly) they will each have
                  there own view of statistics they have collected (in the
                  future we may provide a way to aggregate the various
                  statistics from each thread).
        """
        try:
            return self._local.statistics  # type: ignore[no-any-return]
        except AttributeError:
            self._local.statistics = t.cast(t.Dict[str, t.Any], {})
            return self._local.statistics

    def wraps(self, f: WrappedFn) -> WrappedFn:
        """Wrap a function for retrying.

        :param f: A function to wraps for retrying.
        """

        @functools.wraps(f)
        def wrapped_f(*args: t.Any, **kw: t.Any) -> t.Any:
            return self(f, *args, **kw)

        def retry_with(*args: t.Any, **kwargs: t.Any) -> WrappedFn:
            return self.copy(*args, **kwargs).wraps(f)

        wrapped_f.retry = self  # type: ignore[attr-defined]
        wrapped_f.retry_with = retry_with  # type: ignore[attr-defined]

        return wrapped_f  # type: ignore[return-value]

    def begin(self) -> None:
        self.statistics.clear()
        self.statistics["start_time"] = time.monotonic()
        self.statistics["attempt_number"] = 1
        self.statistics["idle_for"] = 0

    def iter(self, retry_state: "RetryCallState") -> t.Union[DoAttempt, DoSleep, t.Any]:  # noqa
        fut = retry_state.outcome
        if fut is None:
            if self.before is not None:
                self.before(retry_state)
            return DoAttempt()

        is_explicit_retry = fut.failed and isinstance(fut.exception(), TryAgain)
        if not (is_explicit_retry or self.retry(retry_state)):
            return fut.result()

        if self.after is not None:
            self.after(retry_state)

        self.statistics["delay_since_first_attempt"] = retry_state.seconds_since_start
        if self.stop(retry_state):
            if self.retry_error_callback:
                return self.retry_error_callback(retry_state)
            retry_exc = self.retry_error_cls(fut)
            if self.reraise:
                raise retry_exc.reraise()
            raise retry_exc from fut.exception()

        if self.wait:
            sleep = self.wait(retry_state)
        else:
            sleep = 0.0
        retry_state.next_action = RetryAction(sleep)
        retry_state.idle_for += sleep
        self.statistics["idle_for"] += sleep
        self.statistics["attempt_number"] += 1

        if self.before_sleep is not None:
            self.before_sleep(retry_state)

        return DoSleep(sleep)

    def __iter__(self) -> t.Generator[AttemptManager, None, None]:
        self.begin()

        retry_state = RetryCallState(self, fn=None, args=(), kwargs={})
        while True:
            do = self.iter(retry_state=retry_state)
            if isinstance(do, DoAttempt):
                yield AttemptManager(retry_state=retry_state)
            elif isinstance(do, DoSleep):
                retry_state.prepare_for_next_attempt()
                self.sleep(do)
            else:
                break

    @abstractmethod
    def __call__(
        self,
        fn: t.Callable[..., WrappedFnReturnT],
        *args: t.Any,
        **kwargs: t.Any,
    ) -> WrappedFnReturnT:
        pass


class Retrying(BaseRetrying):
    """Retrying controller."""

    def __call__(
        self,
        fn: t.Callable[..., WrappedFnReturnT],
        *args: t.Any,
        **kwargs: t.Any,
    ) -> WrappedFnReturnT:
        self.begin()

        retry_state = RetryCallState(retry_object=self, fn=fn, args=args, kwargs=kwargs)
        while True:
            do = self.iter(retry_state=retry_state)
            if isinstance(do, DoAttempt):
                try:
                    result = fn(*args, **kwargs)
                except BaseException:  # noqa: B902
                    retry_state.set_exception(sys.exc_info())  # type: ignore[arg-type]
                else:
                    retry_state.set_result(result)
            elif isinstance(do, DoSleep):
                retry_state.prepare_for_next_attempt()
                self.sleep(do)
            else:
                return do  # type: ignore[no-any-return]


if sys.version_info[1] >= 9:
    FutureGenericT = futures.Future[t.Any]
else:
    FutureGenericT = futures.Future


class Future(FutureGenericT):
    """Encapsulates a (future or past) attempted call to a target function."""

    def __init__(self, attempt_number: int) -> None:
        super().__init__()
        self.attempt_number = attempt_number

    @property
    def failed(self) -> bool:
        """Return whether a exception is being held in this future."""
        return self.exception() is not None

    @classmethod
    def construct(cls, attempt_number: int, value: t.Any, has_exception: bool) -> "Future":
        """Construct a new Future object."""
        fut = cls(attempt_number)
        if has_exception:
            fut.set_exception(value)
        else:
            fut.set_result(value)
        return fut


class RetryCallState:
    """State related to a single call wrapped with Retrying."""

    def __init__(
        self,
        retry_object: BaseRetrying,
        fn: t.Optional[WrappedFn],
        args: t.Any,
        kwargs: t.Any,
    ) -> None:
        #: Retry call start timestamp
        self.start_time = time.monotonic()
        #: Retry manager object
        self.retry_object = retry_object
        #: Function wrapped by this retry call
        self.fn = fn
        #: Arguments of the function wrapped by this retry call
        self.args = args
        #: Keyword arguments of the function wrapped by this retry call
        self.kwargs = kwargs

        #: The number of the current attempt
        self.attempt_number: int = 1
        #: Last outcome (result or exception) produced by the function
        self.outcome: t.Optional[Future] = None
        #: Timestamp of the last outcome
        self.outcome_timestamp: t.Optional[float] = None
        #: Time spent sleeping in retries
        self.idle_for: float = 0.0
        #: Next action as decided by the retry manager
        self.next_action: t.Optional[RetryAction] = None

    @property
    def seconds_since_start(self) -> t.Optional[float]:
        if self.outcome_timestamp is None:
            return None
        return self.outcome_timestamp - self.start_time

    def prepare_for_next_attempt(self) -> None:
        self.outcome = None
        self.outcome_timestamp = None
        self.attempt_number += 1
        self.next_action = None

    def set_result(self, val: t.Any) -> None:
        ts = time.monotonic()
        fut = Future(self.attempt_number)
        fut.set_result(val)
        self.outcome, self.outcome_timestamp = fut, ts

    def set_exception(
        self, exc_info: t.Tuple[t.Type[BaseException], BaseException, "types.TracebackType| None"]
    ) -> None:
        ts = time.monotonic()
        fut = Future(self.attempt_number)
        fut.set_exception(exc_info[1])
        self.outcome, self.outcome_timestamp = fut, ts

    def __repr__(self) -> str:
        if self.outcome is None:
            result = "none yet"
        elif self.outcome.failed:
            exception = self.outcome.exception()
            result = f"failed ({exception.__class__.__name__} {exception})"
        else:
            result = f"returned {self.outcome.result()}"

        slept = float(round(self.idle_for, 2))
        clsname = self.__class__.__name__
        return f"<{clsname} {id(self)}: attempt #{self.attempt_number}; slept for {slept}; last result: {result}>"


@t.overload
def retry(func: WrappedFn) -> WrappedFn:
    ...


@t.overload
def retry(
    sleep: t.Callable[[t.Union[int, float]], None] = sleep,
    stop: "StopBaseT" = stop_never,
    wait: "WaitBaseT" = wait_none(),
    retry: "RetryBaseT" = retry_if_exception_type(),
    before: t.Callable[["RetryCallState"], None] = before_nothing,
    after: t.Callable[["RetryCallState"], None] = after_nothing,
    before_sleep: t.Optional[t.Callable[["RetryCallState"], None]] = None,
    reraise: bool = False,
    retry_error_cls: t.Type["RetryError"] = RetryError,
    retry_error_callback: t.Optional[t.Callable[["RetryCallState"], t.Any]] = None,
) -> t.Callable[[WrappedFn], WrappedFn]:
    ...


def retry(*dargs: t.Any, **dkw: t.Any) -> t.Any:
    """Wrap a function with a new `Retrying` object.

    :param dargs: positional arguments passed to Retrying object
    :param dkw: keyword arguments passed to the Retrying object
    """
    # support both @retry and @retry() as valid syntax
    if len(dargs) == 1 and callable(dargs[0]):
        return retry()(dargs[0])
    else:

        def wrap(f: WrappedFn) -> WrappedFn:
            if isinstance(f, retry_base):
                warnings.warn(
                    f"Got retry_base instance ({f.__class__.__name__}) as callable argument, "
                    f"this will probably hang indefinitely (did you mean retry={f.__class__.__name__}(...)?)"
                )
            r: "BaseRetrying"
            if iscoroutinefunction(f):
                r = AsyncRetrying(*dargs, **dkw)
            elif tornado and hasattr(tornado.gen, "is_coroutine_function") and tornado.gen.is_coroutine_function(f):
                r = TornadoRetrying(*dargs, **dkw)
            else:
                r = Retrying(*dargs, **dkw)

            return r.wraps(f)

        return wrap


from pip._vendor.tenacity._asyncio import AsyncRetrying  # noqa:E402,I100

if tornado:
    from pip._vendor.tenacity.tornadoweb import TornadoRetrying


__all__ = [
    "retry_base",
    "retry_all",
    "retry_always",
    "retry_any",
    "retry_if_exception",
    "retry_if_exception_type",
    "retry_if_exception_cause_type",
    "retry_if_not_exception_type",
    "retry_if_not_result",
    "retry_if_result",
    "retry_never",
    "retry_unless_exception_type",
    "retry_if_exception_message",
    "retry_if_not_exception_message",
    "sleep",
    "sleep_using_event",
    "stop_after_attempt",
    "stop_after_delay",
    "stop_all",
    "stop_any",
    "stop_never",
    "stop_when_event_set",
    "wait_chain",
    "wait_combine",
    "wait_exponential",
    "wait_fixed",
    "wait_incrementing",
    "wait_none",
    "wait_random",
    "wait_random_exponential",
    "wait_full_jitter",
    "wait_exponential_jitter",
    "before_log",
    "before_nothing",
    "after_log",
    "after_nothing",
    "before_sleep_log",
    "before_sleep_nothing",
    "retry",
    "WrappedFn",
    "TryAgain",
    "NO_RESULT",
    "DoAttempt",
    "DoSleep",
    "BaseAction",
    "RetryAction",
    "RetryError",
    "AttemptManager",
    "BaseRetrying",
    "Retrying",
    "Future",
    "RetryCallState",
    "AsyncRetrying",
]
