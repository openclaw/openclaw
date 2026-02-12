# Copyright 2016 Étienne Bersac
# Copyright 2016 Julien Danjou
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

import time
import typing

if typing.TYPE_CHECKING:
    import threading


def sleep(seconds: float) -> None:
    """
    Sleep strategy that delays execution for a given number of seconds.

    This is the default strategy, and may be mocked out for unit testing.
    """
    time.sleep(seconds)


class sleep_using_event:
    """Sleep strategy that waits on an event to be set."""

    def __init__(self, event: "threading.Event") -> None:
        self.event = event

    def __call__(self, timeout: typing.Optional[float]) -> None:
        # NOTE(harlowja): this may *not* actually wait for timeout
        # seconds if the event is set (ie this may eject out early).
        self.event.wait(timeout=timeout)
