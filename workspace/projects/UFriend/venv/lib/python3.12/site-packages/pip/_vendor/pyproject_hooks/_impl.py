import json
import os
import sys
import tempfile
from contextlib import contextmanager
from os.path import abspath
from os.path import join as pjoin
from subprocess import STDOUT, check_call, check_output

from ._in_process import _in_proc_script_path


def write_json(obj, path, **kwargs):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, **kwargs)


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


class BackendUnavailable(Exception):
    """Will be raised if the backend cannot be imported in the hook process."""
    def __init__(self, traceback):
        self.traceback = traceback


class BackendInvalid(Exception):
    """Will be raised if the backend is invalid."""
    def __init__(self, backend_name, backend_path, message):
        super().__init__(message)
        self.backend_name = backend_name
        self.backend_path = backend_path


class HookMissing(Exception):
    """Will be raised on missing hooks (if a fallback can't be used)."""
    def __init__(self, hook_name):
        super().__init__(hook_name)
        self.hook_name = hook_name


class UnsupportedOperation(Exception):
    """May be raised by build_sdist if the backend indicates that it can't."""
    def __init__(self, traceback):
        self.traceback = traceback


def default_subprocess_runner(cmd, cwd=None, extra_environ=None):
    """The default method of calling the wrapper subprocess.

    This uses :func:`subprocess.check_call` under the hood.
    """
    env = os.environ.copy()
    if extra_environ:
        env.update(extra_environ)

    check_call(cmd, cwd=cwd, env=env)


def quiet_subprocess_runner(cmd, cwd=None, extra_environ=None):
    """Call the subprocess while suppressing output.

    This uses :func:`subprocess.check_output` under the hood.
    """
    env = os.environ.copy()
    if extra_environ:
        env.update(extra_environ)

    check_output(cmd, cwd=cwd, env=env, stderr=STDOUT)


def norm_and_check(source_tree, requested):
    """Normalise and check a backend path.

    Ensure that the requested backend path is specified as a relative path,
    and resolves to a location under the given source tree.

    Return an absolute version of the requested path.
    """
    if os.path.isabs(requested):
        raise ValueError("paths must be relative")

    abs_source = os.path.abspath(source_tree)
    abs_requested = os.path.normpath(os.path.join(abs_source, requested))
    # We have to use commonprefix for Python 2.7 compatibility. So we
    # normalise case to avoid problems because commonprefix is a character
    # based comparison :-(
    norm_source = os.path.normcase(abs_source)
    norm_requested = os.path.normcase(abs_requested)
    if os.path.commonprefix([norm_source, norm_requested]) != norm_source:
        raise ValueError("paths must be inside source tree")

    return abs_requested


class BuildBackendHookCaller:
    """A wrapper to call the build backend hooks for a source directory.
    """

    def __init__(
            self,
            source_dir,
            build_backend,
            backend_path=None,
            runner=None,
            python_executable=None,
    ):
        """
        :param source_dir: The source directory to invoke the build backend for
        :param build_backend: The build backend spec
        :param backend_path: Additional path entries for the build backend spec
        :param runner: The :ref:`subprocess runner <Subprocess Runners>` to use
        :param python_executable:
            The Python executable used to invoke the build backend
        """
        if runner is None:
            runner = default_subprocess_runner

        self.source_dir = abspath(source_dir)
        self.build_backend = build_backend
        if backend_path:
            backend_path = [
                norm_and_check(self.source_dir, p) for p in backend_path
            ]
        self.backend_path = backend_path
        self._subprocess_runner = runner
        if not python_executable:
            python_executable = sys.executable
        self.python_executable = python_executable

    @contextmanager
    def subprocess_runner(self, runner):
        """A context manager for temporarily overriding the default
        :ref:`subprocess runner <Subprocess Runners>`.

        .. code-block:: python

            hook_caller = BuildBackendHookCaller(...)
            with hook_caller.subprocess_runner(quiet_subprocess_runner):
                ...
        """
        prev = self._subprocess_runner
        self._subprocess_runner = runner
        try:
            yield
        finally:
            self._subprocess_runner = prev

    def _supported_features(self):
        """Return the list of optional features supported by the backend."""
        return self._call_hook('_supported_features', {})

    def get_requires_for_build_wheel(self, config_settings=None):
        """Get additional dependencies required for building a wheel.

        :returns: A list of :pep:`dependency specifiers <508>`.
        :rtype: list[str]

        .. admonition:: Fallback

            If the build backend does not defined a hook with this name, an
            empty list will be returned.
        """
        return self._call_hook('get_requires_for_build_wheel', {
            'config_settings': config_settings
        })

    def prepare_metadata_for_build_wheel(
            self, metadata_directory, config_settings=None,
            _allow_fallback=True):
        """Prepare a ``*.dist-info`` folder with metadata for this project.

        :returns: Name of the newly created subfolder within
                  ``metadata_directory``, containing the metadata.
        :rtype: str

        .. admonition:: Fallback

            If the build backend does not define a hook with this name and
            ``_allow_fallback`` is truthy, the backend will be asked to build a
            wheel via the ``build_wheel`` hook and the dist-info extracted from
            that will be returned.
        """
        return self._call_hook('prepare_metadata_for_build_wheel', {
            'metadata_directory': abspath(metadata_directory),
            'config_settings': config_settings,
            '_allow_fallback': _allow_fallback,
        })

    def build_wheel(
            self, wheel_directory, config_settings=None,
            metadata_directory=None):
        """Build a wheel from this project.

        :returns:
            The name of the newly created wheel within ``wheel_directory``.

        .. admonition:: Interaction with fallback

            If the ``build_wheel`` hook was called in the fallback for
            :meth:`prepare_metadata_for_build_wheel`, the build backend would
            not be invoked. Instead, the previously built wheel will be copied
            to ``wheel_directory`` and the name of that file will be returned.
        """
        if metadata_directory is not None:
            metadata_directory = abspath(metadata_directory)
        return self._call_hook('build_wheel', {
            'wheel_directory': abspath(wheel_directory),
            'config_settings': config_settings,
            'metadata_directory': metadata_directory,
        })

    def get_requires_for_build_editable(self, config_settings=None):
        """Get additional dependencies required for building an editable wheel.

        :returns: A list of :pep:`dependency specifiers <508>`.
        :rtype: list[str]

        .. admonition:: Fallback

            If the build backend does not defined a hook with this name, an
            empty list will be returned.
        """
        return self._call_hook('get_requires_for_build_editable', {
            'config_settings': config_settings
        })

    def prepare_metadata_for_build_editable(
            self, metadata_directory, config_settings=None,
            _allow_fallback=True):
        """Prepare a ``*.dist-info`` folder with metadata for this project.

        :returns: Name of the newly created subfolder within
                  ``metadata_directory``, containing the metadata.
        :rtype: str

        .. admonition:: Fallback

            If the build backend does not define a hook with this name and
            ``_allow_fallback`` is truthy, the backend will be asked to build a
            wheel via the ``build_editable`` hook and the dist-info
            extracted from that will be returned.
        """
        return self._call_hook('prepare_metadata_for_build_editable', {
            'metadata_directory': abspath(metadata_directory),
            'config_settings': config_settings,
            '_allow_fallback': _allow_fallback,
        })

    def build_editable(
            self, wheel_directory, config_settings=None,
            metadata_directory=None):
        """Build an editable wheel from this project.

        :returns:
            The name of the newly created wheel within ``wheel_directory``.

        .. admonition:: Interaction with fallback

            If the ``build_editable`` hook was called in the fallback for
            :meth:`prepare_metadata_for_build_editable`, the build backend
            would not be invoked. Instead, the previously built wheel will be
            copied to ``wheel_directory`` and the name of that file will be
            returned.
        """
        if metadata_directory is not None:
            metadata_directory = abspath(metadata_directory)
        return self._call_hook('build_editable', {
            'wheel_directory': abspath(wheel_directory),
            'config_settings': config_settings,
            'metadata_directory': metadata_directory,
        })

    def get_requires_for_build_sdist(self, config_settings=None):
        """Get additional dependencies required for building an sdist.

        :returns: A list of :pep:`dependency specifiers <508>`.
        :rtype: list[str]
        """
        return self._call_hook('get_requires_for_build_sdist', {
            'config_settings': config_settings
        })

    def build_sdist(self, sdist_directory, config_settings=None):
        """Build an sdist from this project.

        :returns:
            The name of the newly created sdist within ``wheel_directory``.
        """
        return self._call_hook('build_sdist', {
            'sdist_directory': abspath(sdist_directory),
            'config_settings': config_settings,
        })

    def _call_hook(self, hook_name, kwargs):
        extra_environ = {'PEP517_BUILD_BACKEND': self.build_backend}

        if self.backend_path:
            backend_path = os.pathsep.join(self.backend_path)
            extra_environ['PEP517_BACKEND_PATH'] = backend_path

        with tempfile.TemporaryDirectory() as td:
            hook_input = {'kwargs': kwargs}
            write_json(hook_input, pjoin(td, 'input.json'), indent=2)

            # Run the hook in a subprocess
            with _in_proc_script_path() as script:
                python = self.python_executable
                self._subprocess_runner(
                    [python, abspath(str(script)), hook_name, td],
                    cwd=self.source_dir,
                    extra_environ=extra_environ
                )

            data = read_json(pjoin(td, 'output.json'))
            if data.get('unsupported'):
                raise UnsupportedOperation(data.get('traceback', ''))
            if data.get('no_backend'):
                raise BackendUnavailable(data.get('traceback', ''))
            if data.get('backend_invalid'):
                raise BackendInvalid(
                    backend_name=self.build_backend,
                    backend_path=self.backend_path,
                    message=data.get('backend_error', '')
                )
            if data.get('hook_missing'):
                raise HookMissing(data.get('missing_hook_name') or hook_name)
            return data['return_val']
