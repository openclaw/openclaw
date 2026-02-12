# DEBUG and error logging

from lxml.includes cimport xmlerror
from lxml cimport cvarargs

DEF GLOBAL_ERROR_LOG = "_GlobalErrorLog"
DEF XSLT_ERROR_LOG = "_XSLTErrorLog"

# module level API functions

def clear_error_log():
    """clear_error_log()

    Clear the global error log.  Note that this log is already bound to a
    fixed size.

    Note: since lxml 2.2, the global error log is local to a thread
    and this function will only clear the global error log of the
    current thread.
    """
    _getThreadErrorLog(GLOBAL_ERROR_LOG).clear()


# setup for global log:

cdef void _initThreadLogging() noexcept:
    # Disable generic error lines from libxml2.
    _connectGenericErrorLog(None)

    # Divert XSLT error messages to the global XSLT error log instead of stderr.
    xslt.xsltSetGenericErrorFunc(NULL, <xmlerror.xmlGenericErrorFunc>_receiveXSLTError)


# Logging classes

@cython.final
@cython.freelist(16)
cdef class _LogEntry:
    """A log message entry from an error log.

    Attributes:

    - message: the message text
    - domain: the domain ID (see lxml.etree.ErrorDomains)
    - type: the message type ID (see lxml.etree.ErrorTypes)
    - level: the log level ID (see lxml.etree.ErrorLevels)
    - line: the line at which the message originated (if applicable)
    - column: the character column at which the message originated (if applicable)
    - filename: the name of the file in which the message originated (if applicable)
    - path: the location in which the error was found (if available)
    """
    cdef readonly int domain
    cdef readonly int type
    cdef readonly int level
    cdef readonly long line
    cdef readonly int column
    cdef basestring _message
    cdef basestring _filename
    cdef char* _c_message
    cdef xmlChar* _c_filename
    cdef xmlChar* _c_path

    def __dealloc__(self):
        tree.xmlFree(self._c_message)
        tree.xmlFree(self._c_filename)
        tree.xmlFree(self._c_path)

    @cython.final
    cdef int _setError(self, const xmlerror.xmlError* error) except -1:
        self.domain   = error.domain
        self.type     = error.code
        self.level    = <int>error.level
        self.line     = <long>error.line
        self.column   = error.int2
        self._c_message = NULL
        self._c_filename = NULL
        self._c_path = NULL
        if (error.message is NULL or
                error.message[0] == b'\0' or
                error.message[0] == b'\n' and error.message[1] == b'\0'):
            self._message = "unknown error"
        else:
            self._message = None
            self._c_message = <char*> tree.xmlStrdup(
                <const_xmlChar*> error.message)
            if not self._c_message:
                raise MemoryError()
        if error.file is NULL:
            self._filename = '<string>'
        else:
            self._filename = None
            self._c_filename = tree.xmlStrdup(<const_xmlChar*> error.file)
            if not self._c_filename:
                raise MemoryError()
        if error.node is not NULL:
            self._c_path = tree.xmlGetNodePath(<xmlNode*> error.node)
            c_line = tree.xmlGetLineNo(<xmlNode*> error.node)
            if c_line > limits.INT_MAX:
                self.line = c_line

    @cython.final
    cdef _setGeneric(self, int domain, int type, int level, long line,
                     message, filename):
        self.domain  = domain
        self.type    = type
        self.level   = level
        self.line    = line
        self.column  = 0
        self._message = message
        self._filename = filename
        self._c_path = NULL

    def __repr__(self):
        return "%s:%d:%d:%s:%s:%s: %s" % (
            self.filename, self.line, self.column, self.level_name,
            self.domain_name, self.type_name, self.message)

    @property
    def domain_name(self):
        """The name of the error domain.  See lxml.etree.ErrorDomains
        """
        return ErrorDomains._getName(self.domain, "unknown")

    @property
    def type_name(self):
        """The name of the error type.  See lxml.etree.ErrorTypes
        """
        if self.domain == ErrorDomains.RELAXNGV:
            getName = RelaxNGErrorTypes._getName
        else:
            getName = ErrorTypes._getName
        return getName(self.type, "unknown")

    @property
    def level_name(self):
        """The name of the error level.  See lxml.etree.ErrorLevels
        """
        return ErrorLevels._getName(self.level, "unknown")

    @property
    def message(self):
        """The log message string.
        """
        cdef size_t size
        if self._message is not None:
            return self._message
        if self._c_message is NULL:
            return None
        size = cstring_h.strlen(self._c_message)
        if size > 0 and self._c_message[size-1] == b'\n':
            size -= 1  # strip EOL
        # cannot use funicode() here because the message may contain
        # byte encoded file paths etc.
        try:
            self._message = self._c_message[:size].decode('utf8')
        except UnicodeDecodeError:
            try:
                self._message = self._c_message[:size].decode(
                    'ascii', 'backslashreplace')
            except UnicodeDecodeError:
                self._message = '<undecodable error message>'
        if self._c_message:
            # clean up early
            tree.xmlFree(self._c_message)
            self._c_message = NULL
        return self._message

    @property
    def filename(self):
        """The file path where the report originated, if any.
        """
        if self._filename is None:
            if self._c_filename is not NULL:
                self._filename = _decodeFilename(self._c_filename)
                # clean up early
                tree.xmlFree(self._c_filename)
                self._c_filename = NULL
        return self._filename

    @property
    def path(self):
        """The XPath for the node where the error was detected.
        """
        return funicode(self._c_path) if self._c_path is not NULL else None


cdef class _BaseErrorLog:
    cdef _LogEntry _first_error
    cdef readonly object last_error
    def __init__(self, first_error, last_error):
        self._first_error = first_error
        self.last_error = last_error

    cpdef copy(self):
        return _BaseErrorLog(self._first_error, self.last_error)

    def __repr__(self):
        return ''

    cpdef receive(self, _LogEntry entry):
        pass

    @cython.final
    cdef int _receive(self, const xmlerror.xmlError* error) except -1:
        cdef bint is_error
        cdef _LogEntry entry
        cdef _BaseErrorLog global_log
        entry = _LogEntry.__new__(_LogEntry)
        entry._setError(error)
        is_error = error.level == xmlerror.XML_ERR_ERROR or \
                   error.level == xmlerror.XML_ERR_FATAL
        global_log = _getThreadErrorLog(GLOBAL_ERROR_LOG)
        if global_log is not self:
            global_log.receive(entry)
            if is_error:
                global_log.last_error = entry
        self.receive(entry)
        if is_error:
            self.last_error = entry

    @cython.final
    cdef int _receiveGeneric(self, int domain, int type, int level, long line,
                             message, filename) except -1:
        cdef bint is_error
        cdef _LogEntry entry
        cdef _BaseErrorLog global_log
        entry = _LogEntry.__new__(_LogEntry)
        entry._setGeneric(domain, type, level, line, message, filename)
        is_error = level == xmlerror.XML_ERR_ERROR or \
                   level == xmlerror.XML_ERR_FATAL
        global_log = _getThreadErrorLog(GLOBAL_ERROR_LOG)
        if global_log is not self:
            global_log.receive(entry)
            if is_error:
                global_log.last_error = entry
        self.receive(entry)
        if is_error:
            self.last_error = entry

    @cython.final
    cdef _buildParseException(self, exctype, default_message):
        code = xmlerror.XML_ERR_INTERNAL_ERROR
        if self._first_error is None:
            return exctype(default_message, code, 0, 0)
        message = self._first_error.message
        if message:
            code = self._first_error.type
        else:
            message = default_message
        line = self._first_error.line
        column = self._first_error.column
        filename = self._first_error.filename
        if line > 0:
            if column > 0:
                message = f"{message}, line {line}, column {column}"
            else:
                message = f"{message}, line {line}"
        return exctype(message, code, line, column, filename)

    @cython.final
    cdef _buildExceptionMessage(self, default_message):
        if self._first_error is None:
            return default_message
        if self._first_error.message:
            message = self._first_error.message
        elif default_message is None:
            return None
        else:
            message = default_message
        if self._first_error.line > 0:
            if self._first_error.column > 0:
                message = f"{message}, line {self._first_error.line}, column {self._first_error.column}"
            else:
                message = f"{message}, line {self._first_error.line}"
        return message

cdef class _ListErrorLog(_BaseErrorLog):
    "Immutable base version of a list based error log."
    cdef list _entries
    cdef int _offset
    def __init__(self, entries, first_error, last_error):
        if entries:
            if first_error is None:
                first_error = entries[0]
            if last_error is None:
                last_error = entries[-1]
        _BaseErrorLog.__init__(self, first_error, last_error)
        self._entries = entries

    cpdef copy(self):
        """Creates a shallow copy of this error log.  Reuses the list of
        entries.
        """
        cdef _ListErrorLog log = _ListErrorLog(
            self._entries, self._first_error, self.last_error)
        log._offset = self._offset
        return log

    def __iter__(self):
        entries = self._entries
        if self._offset:
            entries = islice(entries, self._offset)
        return iter(entries)

    def __repr__(self):
        return '\n'.join([repr(entry) for entry in self])

    def __getitem__(self, index):
        if self._offset:
            index += self._offset
        return self._entries[index]

    def __len__(self):
        return len(self._entries) - self._offset

    def __contains__(self, error_type):
        cdef Py_ssize_t i
        for i, entry in enumerate(self._entries):
            if i < self._offset:
                continue
            if entry.type == error_type:
                return True
        return False

    def __bool__(self):
        return len(self._entries) > self._offset

    def filter_domains(self, domains):
        """Filter the errors by the given domains and return a new error log
        containing the matches.
        """
        cdef _LogEntry entry
        if isinstance(domains, int):
            domains = (domains,)
        filtered = [entry for entry in self if entry.domain in domains]
        return _ListErrorLog(filtered, None, None)

    def filter_types(self, types):
        """filter_types(self, types)

        Filter the errors by the given types and return a new error
        log containing the matches.
        """
        cdef _LogEntry entry
        if isinstance(types, int):
            types = (types,)
        filtered = [entry for entry in self if entry.type in types]
        return _ListErrorLog(filtered, None, None)

    def filter_levels(self, levels):
        """filter_levels(self, levels)

        Filter the errors by the given error levels and return a new
        error log containing the matches.
        """
        cdef _LogEntry entry
        if isinstance(levels, int):
            levels = (levels,)
        filtered = [entry for entry in self if entry.level in levels]
        return _ListErrorLog(filtered, None, None)

    def filter_from_level(self, level):
        """filter_from_level(self, level)

        Return a log with all messages of the requested level of worse.
        """
        cdef _LogEntry entry
        filtered = [entry for entry in self if entry.level >= level]
        return _ListErrorLog(filtered, None, None)

    def filter_from_fatals(self):
        """filter_from_fatals(self)

        Convenience method to get all fatal error messages.
        """
        return self.filter_from_level(ErrorLevels.FATAL)
    
    def filter_from_errors(self):
        """filter_from_errors(self)

        Convenience method to get all error messages or worse.
        """
        return self.filter_from_level(ErrorLevels.ERROR)
    
    def filter_from_warnings(self):
        """filter_from_warnings(self)

        Convenience method to get all warnings or worse.
        """
        return self.filter_from_level(ErrorLevels.WARNING)


@cython.final
@cython.internal
cdef class _ErrorLogContext:
    """
    Error log context for the 'with' statement.
    Stores a reference to the current callbacks to allow for
    recursively stacked log contexts.
    """
    cdef xmlerror.xmlStructuredErrorFunc old_error_func
    cdef void* old_error_context
    cdef xmlerror.xmlGenericErrorFunc old_xslt_error_func
    cdef void* old_xslt_error_context
    cdef _BaseErrorLog old_xslt_error_log

    cdef int push_error_log(self, _BaseErrorLog log) except -1:
        self.old_error_func = xmlerror.xmlStructuredError
        self.old_error_context = xmlerror.xmlStructuredErrorContext
        xmlerror.xmlSetStructuredErrorFunc(
            <void*>log, <xmlerror.xmlStructuredErrorFunc>_receiveError)

        # xslt.xsltSetGenericErrorFunc() is not thread-local => keep error log in TLS
        self.old_xslt_error_func = xslt.xsltGenericError
        self.old_xslt_error_context = xslt.xsltGenericErrorContext
        self.old_xslt_error_log = _getThreadErrorLog(XSLT_ERROR_LOG)
        _setThreadErrorLog(XSLT_ERROR_LOG, log)
        xslt.xsltSetGenericErrorFunc(
            NULL, <xmlerror.xmlGenericErrorFunc>_receiveXSLTError)
        return 0

    cdef int pop_error_log(self) except -1:
        xmlerror.xmlSetStructuredErrorFunc(
            self.old_error_context, self.old_error_func)
        xslt.xsltSetGenericErrorFunc(
            self.old_xslt_error_context, self.old_xslt_error_func)
        _setThreadErrorLog(XSLT_ERROR_LOG, self.old_xslt_error_log)
        self.old_xslt_error_log= None
        return 0


cdef class _ErrorLog(_ListErrorLog):
    cdef list _logContexts
    def __cinit__(self):
        self._logContexts = []

    def __init__(self):
        _ListErrorLog.__init__(self, [], None, None)

    @cython.final
    cdef int __enter__(self) except -1:
        return self.connect()

    def __exit__(self, *args):
        #  TODO: make this a cdef function when Cython supports it
        self.disconnect()

    @cython.final
    cdef int connect(self) except -1:
        self._first_error = None
        del self._entries[:]

        cdef _ErrorLogContext context = _ErrorLogContext.__new__(_ErrorLogContext)
        context.push_error_log(self)
        self._logContexts.append(context)
        return 0

    @cython.final
    cdef int disconnect(self) except -1:
        cdef _ErrorLogContext context = self._logContexts.pop()
        context.pop_error_log()
        return 0

    cpdef clear(self):
        self._first_error = None
        self.last_error = None
        self._offset = 0
        del self._entries[:]

    cpdef copy(self):
        """Creates a shallow copy of this error log and the list of entries.
        """
        return _ListErrorLog(
            self._entries[self._offset:],
            self._first_error, self.last_error)

    def __iter__(self):
        return iter(self._entries[self._offset:])

    cpdef receive(self, _LogEntry entry):
        if self._first_error is None and entry.level >= xmlerror.XML_ERR_ERROR:
            self._first_error = entry
        self._entries.append(entry)

cdef class _DomainErrorLog(_ErrorLog):
    def __init__(self, domains):
        _ErrorLog.__init__(self)
        self._accepted_domains = tuple(domains)

    cpdef receive(self, _LogEntry entry):
        if entry.domain in self._accepted_domains:
            _ErrorLog.receive(self, entry)

cdef class _RotatingErrorLog(_ErrorLog):
    cdef int _max_len
    def __init__(self, max_len):
        _ErrorLog.__init__(self)
        self._max_len = max_len

    cpdef receive(self, _LogEntry entry):
        if self._first_error is None and entry.level >= xmlerror.XML_ERR_ERROR:
            self._first_error = entry
        self._entries.append(entry)

        if len(self._entries) > self._max_len:
            self._offset += 1
            if self._offset > self._max_len // 3:
                offset = self._offset
                self._offset = 0
                del self._entries[:offset]

cdef class PyErrorLog(_BaseErrorLog):
    """PyErrorLog(self, logger_name=None, logger=None)
    A global error log that connects to the Python stdlib logging package.

    The constructor accepts an optional logger name or a readily
    instantiated logger instance.

    If you want to change the mapping between libxml2's ErrorLevels and Python
    logging levels, you can modify the level_map dictionary from a subclass.

    The default mapping is::

            ErrorLevels.WARNING = logging.WARNING
            ErrorLevels.ERROR   = logging.ERROR
            ErrorLevels.FATAL   = logging.CRITICAL

    You can also override the method ``receive()`` that takes a LogEntry
    object and calls ``self.log(log_entry, format_string, arg1, arg2, ...)``
    with appropriate data.
    """
    cdef readonly dict level_map
    cdef object _map_level
    cdef object _log
    def __init__(self, logger_name=None, logger=None):
        _BaseErrorLog.__init__(self, None, None)
        import logging
        self.level_map = {
            ErrorLevels.WARNING : logging.WARNING,
            ErrorLevels.ERROR   : logging.ERROR,
            ErrorLevels.FATAL   : logging.CRITICAL
            }
        self._map_level = self.level_map.get
        if logger is None:
            if logger_name:
                logger = logging.getLogger(logger_name)
            else:
                logger = logging.getLogger()
        self._log = logger.log

    cpdef copy(self):
        """Dummy method that returns an empty error log.
        """
        return _ListErrorLog([], None, None)

    def log(self, log_entry, message, *args):
        """log(self, log_entry, message, *args)

        Called by the .receive() method to log a _LogEntry instance to
        the Python logging system.  This handles the error level
        mapping.

        In the default implementation, the ``message`` argument
        receives a complete log line, and there are no further
        ``args``.  To change the message format, it is best to
        override the .receive() method instead of this one.
        """
        self._log(
            self._map_level(log_entry.level, 0),
            message, *args
            )

    cpdef receive(self, _LogEntry log_entry):
        """receive(self, log_entry)

        Receive a _LogEntry instance from the logging system.  Calls
        the .log() method with appropriate parameters::

            self.log(log_entry, repr(log_entry))

        You can override this method to provide your own log output
        format.
        """
        self.log(log_entry, repr(log_entry))

# thread-local, global list log to collect error output messages from
# libxml2/libxslt

cdef _BaseErrorLog __GLOBAL_ERROR_LOG = _RotatingErrorLog(__MAX_LOG_SIZE)


cdef _BaseErrorLog _getThreadErrorLog(name):
    """Retrieve the current error log with name 'name' of this thread."""
    cdef python.PyObject* thread_dict
    thread_dict = python.PyThreadState_GetDict()
    if thread_dict is NULL:
        return __GLOBAL_ERROR_LOG
    try:
        return (<object>thread_dict)[name]
    except KeyError:
        log = (<object>thread_dict)[name] = \
              _RotatingErrorLog(__MAX_LOG_SIZE)
        return log


cdef _setThreadErrorLog(name, _BaseErrorLog log):
    """Set the global error log of this thread."""
    cdef python.PyObject* thread_dict
    thread_dict = python.PyThreadState_GetDict()
    if thread_dict is NULL:
        if name == GLOBAL_ERROR_LOG:
            global __GLOBAL_ERROR_LOG
            __GLOBAL_ERROR_LOG = log
    else:
        (<object>thread_dict)[name] = log


cdef __copyGlobalErrorLog():
    "Helper function for properties in exceptions."
    return _getThreadErrorLog(GLOBAL_ERROR_LOG).copy()


def use_global_python_log(PyErrorLog log not None):
    """use_global_python_log(log)

    Replace the global error log by an etree.PyErrorLog that uses the
    standard Python logging package.

    Note that this disables access to the global error log from exceptions.
    Parsers, XSLT etc. will continue to provide their normal local error log.

    Note: prior to lxml 2.2, this changed the error log globally.
    Since lxml 2.2, the global error log is local to a thread and this
    function will only set the global error log of the current thread.
    """
    _setThreadErrorLog(GLOBAL_ERROR_LOG, log)


# local log functions: forward error to logger object
cdef void _forwardError(void* c_log_handler, const xmlerror.xmlError* error) noexcept with gil:
    cdef _BaseErrorLog log_handler
    if c_log_handler is not NULL:
        log_handler = <_BaseErrorLog>c_log_handler
    elif error.domain == xmlerror.XML_FROM_XSLT:
        log_handler = _getThreadErrorLog(XSLT_ERROR_LOG)
    else:
        log_handler = _getThreadErrorLog(GLOBAL_ERROR_LOG)
    log_handler._receive(error)


cdef void _receiveError(void* c_log_handler, const xmlerror.xmlError* error) noexcept nogil:
    # no Python objects here, may be called without thread context !
    if __DEBUG:
        _forwardError(c_log_handler, error)


cdef void _receiveXSLTError(void* c_log_handler, char* msg, ...) noexcept nogil:
    # no Python objects here, may be called without thread context !
    cdef cvarargs.va_list args
    cvarargs.va_start(args, msg)
    _receiveGenericError(c_log_handler, xmlerror.XML_FROM_XSLT, msg, args)
    cvarargs.va_end(args)

cdef void _receiveRelaxNGParseError(void* c_log_handler, char* msg, ...) noexcept nogil:
    # no Python objects here, may be called without thread context !
    cdef cvarargs.va_list args
    cvarargs.va_start(args, msg)
    _receiveGenericError(c_log_handler, xmlerror.XML_FROM_RELAXNGP, msg, args)
    cvarargs.va_end(args)

cdef void _receiveRelaxNGValidationError(void* c_log_handler, char* msg, ...) noexcept nogil:
    # no Python objects here, may be called without thread context !
    cdef cvarargs.va_list args
    cvarargs.va_start(args, msg)
    _receiveGenericError(c_log_handler, xmlerror.XML_FROM_RELAXNGV, msg, args)
    cvarargs.va_end(args)

# dummy function: no log output at all
cdef void _nullGenericErrorFunc(void* ctxt, char* msg, ...) noexcept nogil:
    pass


cdef void _connectGenericErrorLog(log, int c_domain=-1) noexcept:
    cdef xmlerror.xmlGenericErrorFunc error_func = NULL
    c_log = <void*>log
    if c_domain == xmlerror.XML_FROM_XSLT:
        error_func = <xmlerror.xmlGenericErrorFunc>_receiveXSLTError
    elif c_domain == xmlerror.XML_FROM_RELAXNGP:
        error_func = <xmlerror.xmlGenericErrorFunc>_receiveRelaxNGParseError
    elif c_domain == xmlerror.XML_FROM_RELAXNGV:
        error_func = <xmlerror.xmlGenericErrorFunc>_receiveRelaxNGValidationError

    if log is None or error_func is NULL:
        c_log = NULL
        error_func = <xmlerror.xmlGenericErrorFunc>_nullGenericErrorFunc
    xmlerror.xmlSetGenericErrorFunc(c_log, error_func)


cdef void _receiveGenericError(void* c_log_handler, int c_domain,
                               char* msg, cvarargs.va_list args) noexcept nogil:
    # no Python objects here, may be called without thread context !
    cdef xmlerror.xmlError c_error
    cdef char* c_text
    cdef char* c_message
    cdef char* c_element
    cdef char* c_pos
    cdef char* c_name_pos
    cdef char* c_str
    cdef int text_size, element_size, format_count, c_int
    if not __DEBUG or msg is NULL:
        return
    if msg[0] in b'\n\0':
        return

    c_text = c_element = c_error.file = c_error.node = NULL
    c_error.line = 0

    # parse "NAME %s" chunks from the format string
    c_name_pos = c_pos = msg
    format_count = 0
    while c_pos[0]:
        if c_pos[0] == b'%':
            c_pos += 1
            if c_pos[0] == b's':  # "%s"
                format_count += 1
                c_str = cvarargs.va_charptr(args)
                if c_pos == msg + 1:
                    c_text = c_str  # msg == "%s..."
                elif c_name_pos[0] == b'e':
                    if cstring_h.strncmp(c_name_pos, 'element %s', 10) == 0:
                        c_element = c_str
                elif c_name_pos[0] == b'f':
                    if cstring_h.strncmp(c_name_pos, 'file %s', 7) == 0:
                        if cstring_h.strncmp('string://__STRING__XSLT',
                                             c_str, 23) == 0:
                            c_str = '<xslt>'
                        c_error.file = c_str
            elif c_pos[0] == b'd':  # "%d"
                format_count += 1
                c_int = cvarargs.va_int(args)
                if cstring_h.strncmp(c_name_pos, 'line %d', 7) == 0:
                    c_error.line = c_int
            elif c_pos[0] != b'%':  # "%%" == "%"
                format_count += 1
                break  # unexpected format or end of string => abort
        elif c_pos[0] == b' ':
            if c_pos[1] != b'%':
                c_name_pos = c_pos + 1
        c_pos += 1

    c_message = NULL
    if c_text is NULL:
        if c_element is not NULL and format_count == 1:
            # special case: a single occurrence of 'element %s'
            text_size    = cstring_h.strlen(msg)
            element_size = cstring_h.strlen(c_element)
            c_message = <char*>stdlib.malloc(
                (text_size + element_size + 1) * sizeof(char))
            stdio.sprintf(c_message, msg, c_element)
            c_error.message = c_message
        else:
            c_error.message = ''
    elif c_element is NULL:
        c_error.message = c_text
    else:
        text_size    = cstring_h.strlen(c_text)
        element_size = cstring_h.strlen(c_element)
        c_message = <char*>stdlib.malloc(
            (text_size + 12 + element_size + 1) * sizeof(char))
        if c_message is NULL:
            c_error.message = c_text
        else:
            stdio.sprintf(c_message, "%s, element '%s'", c_text, c_element)
            c_error.message = c_message

    c_error.domain = c_domain
    c_error.code   = xmlerror.XML_ERR_OK    # what else?
    c_error.level  = xmlerror.XML_ERR_ERROR # what else?
    c_error.int2   = 0

    _forwardError(c_log_handler, &c_error)

    if c_message is not NULL:
        stdlib.free(c_message)

################################################################################
## CONSTANTS FROM "xmlerror.h" (or rather libxml-xmlerror.html)
################################################################################

cdef __initErrorConstants():
    "Called at setup time to parse the constants and build the classes below."
    global __ERROR_LEVELS, __ERROR_DOMAINS, __PARSER_ERROR_TYPES, __RELAXNG_ERROR_TYPES
    const_defs = ((ErrorLevels,          __ERROR_LEVELS),
                  (ErrorDomains,         __ERROR_DOMAINS),
                  (ErrorTypes,           __PARSER_ERROR_TYPES),
                  (RelaxNGErrorTypes,    __RELAXNG_ERROR_TYPES))

    for cls, constants in const_defs:
        reverse_dict = {}
        cls._names   = reverse_dict
        cls._getName = reverse_dict.get
        for line in constants.splitlines():
            if not line:
                continue
            name, value = line.split('=')
            value = int(value)
            setattr(cls, name, value)
            reverse_dict[value] = name

    # discard the global string references after use
    __ERROR_LEVELS = __ERROR_DOMAINS = __PARSER_ERROR_TYPES = __RELAXNG_ERROR_TYPES = None


class ErrorLevels(object):
    """Libxml2 error levels"""

class ErrorDomains(object):
    """Libxml2 error domains"""

class ErrorTypes(object):
    """Libxml2 error types"""

class RelaxNGErrorTypes(object):
    """Libxml2 RelaxNG error types"""


# --- BEGIN: GENERATED CONSTANTS ---

# This section is generated by the script 'update-error-constants.py'.

cdef object __ERROR_LEVELS = """\
NONE=0
WARNING=1
ERROR=2
FATAL=3
"""

cdef object __ERROR_DOMAINS = """\
NONE=0
PARSER=1
TREE=2
NAMESPACE=3
DTD=4
HTML=5
MEMORY=6
OUTPUT=7
IO=8
FTP=9
HTTP=10
XINCLUDE=11
XPATH=12
XPOINTER=13
REGEXP=14
DATATYPE=15
SCHEMASP=16
SCHEMASV=17
RELAXNGP=18
RELAXNGV=19
CATALOG=20
C14N=21
XSLT=22
VALID=23
CHECK=24
WRITER=25
MODULE=26
I18N=27
SCHEMATRONV=28
BUFFER=29
URI=30
"""

cdef object __PARSER_ERROR_TYPES = """\
ERR_OK=0
ERR_INTERNAL_ERROR=1
ERR_NO_MEMORY=2
ERR_DOCUMENT_START=3
ERR_DOCUMENT_EMPTY=4
ERR_DOCUMENT_END=5
ERR_INVALID_HEX_CHARREF=6
ERR_INVALID_DEC_CHARREF=7
ERR_INVALID_CHARREF=8
ERR_INVALID_CHAR=9
ERR_CHARREF_AT_EOF=10
ERR_CHARREF_IN_PROLOG=11
ERR_CHARREF_IN_EPILOG=12
ERR_CHARREF_IN_DTD=13
ERR_ENTITYREF_AT_EOF=14
ERR_ENTITYREF_IN_PROLOG=15
ERR_ENTITYREF_IN_EPILOG=16
ERR_ENTITYREF_IN_DTD=17
ERR_PEREF_AT_EOF=18
ERR_PEREF_IN_PROLOG=19
ERR_PEREF_IN_EPILOG=20
ERR_PEREF_IN_INT_SUBSET=21
ERR_ENTITYREF_NO_NAME=22
ERR_ENTITYREF_SEMICOL_MISSING=23
ERR_PEREF_NO_NAME=24
ERR_PEREF_SEMICOL_MISSING=25
ERR_UNDECLARED_ENTITY=26
WAR_UNDECLARED_ENTITY=27
ERR_UNPARSED_ENTITY=28
ERR_ENTITY_IS_EXTERNAL=29
ERR_ENTITY_IS_PARAMETER=30
ERR_UNKNOWN_ENCODING=31
ERR_UNSUPPORTED_ENCODING=32
ERR_STRING_NOT_STARTED=33
ERR_STRING_NOT_CLOSED=34
ERR_NS_DECL_ERROR=35
ERR_ENTITY_NOT_STARTED=36
ERR_ENTITY_NOT_FINISHED=37
ERR_LT_IN_ATTRIBUTE=38
ERR_ATTRIBUTE_NOT_STARTED=39
ERR_ATTRIBUTE_NOT_FINISHED=40
ERR_ATTRIBUTE_WITHOUT_VALUE=41
ERR_ATTRIBUTE_REDEFINED=42
ERR_LITERAL_NOT_STARTED=43
ERR_LITERAL_NOT_FINISHED=44
ERR_COMMENT_NOT_FINISHED=45
ERR_PI_NOT_STARTED=46
ERR_PI_NOT_FINISHED=47
ERR_NOTATION_NOT_STARTED=48
ERR_NOTATION_NOT_FINISHED=49
ERR_ATTLIST_NOT_STARTED=50
ERR_ATTLIST_NOT_FINISHED=51
ERR_MIXED_NOT_STARTED=52
ERR_MIXED_NOT_FINISHED=53
ERR_ELEMCONTENT_NOT_STARTED=54
ERR_ELEMCONTENT_NOT_FINISHED=55
ERR_XMLDECL_NOT_STARTED=56
ERR_XMLDECL_NOT_FINISHED=57
ERR_CONDSEC_NOT_STARTED=58
ERR_CONDSEC_NOT_FINISHED=59
ERR_EXT_SUBSET_NOT_FINISHED=60
ERR_DOCTYPE_NOT_FINISHED=61
ERR_MISPLACED_CDATA_END=62
ERR_CDATA_NOT_FINISHED=63
ERR_RESERVED_XML_NAME=64
ERR_SPACE_REQUIRED=65
ERR_SEPARATOR_REQUIRED=66
ERR_NMTOKEN_REQUIRED=67
ERR_NAME_REQUIRED=68
ERR_PCDATA_REQUIRED=69
ERR_URI_REQUIRED=70
ERR_PUBID_REQUIRED=71
ERR_LT_REQUIRED=72
ERR_GT_REQUIRED=73
ERR_LTSLASH_REQUIRED=74
ERR_EQUAL_REQUIRED=75
ERR_TAG_NAME_MISMATCH=76
ERR_TAG_NOT_FINISHED=77
ERR_STANDALONE_VALUE=78
ERR_ENCODING_NAME=79
ERR_HYPHEN_IN_COMMENT=80
ERR_INVALID_ENCODING=81
ERR_EXT_ENTITY_STANDALONE=82
ERR_CONDSEC_INVALID=83
ERR_VALUE_REQUIRED=84
ERR_NOT_WELL_BALANCED=85
ERR_EXTRA_CONTENT=86
ERR_ENTITY_CHAR_ERROR=87
ERR_ENTITY_PE_INTERNAL=88
ERR_ENTITY_LOOP=89
ERR_ENTITY_BOUNDARY=90
ERR_INVALID_URI=91
ERR_URI_FRAGMENT=92
WAR_CATALOG_PI=93
ERR_NO_DTD=94
ERR_CONDSEC_INVALID_KEYWORD=95
ERR_VERSION_MISSING=96
WAR_UNKNOWN_VERSION=97
WAR_LANG_VALUE=98
WAR_NS_URI=99
WAR_NS_URI_RELATIVE=100
ERR_MISSING_ENCODING=101
WAR_SPACE_VALUE=102
ERR_NOT_STANDALONE=103
ERR_ENTITY_PROCESSING=104
ERR_NOTATION_PROCESSING=105
WAR_NS_COLUMN=106
WAR_ENTITY_REDEFINED=107
ERR_UNKNOWN_VERSION=108
ERR_VERSION_MISMATCH=109
ERR_NAME_TOO_LONG=110
ERR_USER_STOP=111
ERR_COMMENT_ABRUPTLY_ENDED=112
WAR_ENCODING_MISMATCH=113
ERR_RESOURCE_LIMIT=114
ERR_ARGUMENT=115
ERR_SYSTEM=116
ERR_REDECL_PREDEF_ENTITY=117
ERR_INT_SUBSET_NOT_FINISHED=118
NS_ERR_XML_NAMESPACE=200
NS_ERR_UNDEFINED_NAMESPACE=201
NS_ERR_QNAME=202
NS_ERR_ATTRIBUTE_REDEFINED=203
NS_ERR_EMPTY=204
NS_ERR_COLON=205
DTD_ATTRIBUTE_DEFAULT=500
DTD_ATTRIBUTE_REDEFINED=501
DTD_ATTRIBUTE_VALUE=502
DTD_CONTENT_ERROR=503
DTD_CONTENT_MODEL=504
DTD_CONTENT_NOT_DETERMINIST=505
DTD_DIFFERENT_PREFIX=506
DTD_ELEM_DEFAULT_NAMESPACE=507
DTD_ELEM_NAMESPACE=508
DTD_ELEM_REDEFINED=509
DTD_EMPTY_NOTATION=510
DTD_ENTITY_TYPE=511
DTD_ID_FIXED=512
DTD_ID_REDEFINED=513
DTD_ID_SUBSET=514
DTD_INVALID_CHILD=515
DTD_INVALID_DEFAULT=516
DTD_LOAD_ERROR=517
DTD_MISSING_ATTRIBUTE=518
DTD_MIXED_CORRUPT=519
DTD_MULTIPLE_ID=520
DTD_NO_DOC=521
DTD_NO_DTD=522
DTD_NO_ELEM_NAME=523
DTD_NO_PREFIX=524
DTD_NO_ROOT=525
DTD_NOTATION_REDEFINED=526
DTD_NOTATION_VALUE=527
DTD_NOT_EMPTY=528
DTD_NOT_PCDATA=529
DTD_NOT_STANDALONE=530
DTD_ROOT_NAME=531
DTD_STANDALONE_WHITE_SPACE=532
DTD_UNKNOWN_ATTRIBUTE=533
DTD_UNKNOWN_ELEM=534
DTD_UNKNOWN_ENTITY=535
DTD_UNKNOWN_ID=536
DTD_UNKNOWN_NOTATION=537
DTD_STANDALONE_DEFAULTED=538
DTD_XMLID_VALUE=539
DTD_XMLID_TYPE=540
DTD_DUP_TOKEN=541
HTML_STRUCURE_ERROR=800
HTML_UNKNOWN_TAG=801
HTML_INCORRECTLY_OPENED_COMMENT=802
RNGP_ANYNAME_ATTR_ANCESTOR=1000
RNGP_ATTR_CONFLICT=1001
RNGP_ATTRIBUTE_CHILDREN=1002
RNGP_ATTRIBUTE_CONTENT=1003
RNGP_ATTRIBUTE_EMPTY=1004
RNGP_ATTRIBUTE_NOOP=1005
RNGP_CHOICE_CONTENT=1006
RNGP_CHOICE_EMPTY=1007
RNGP_CREATE_FAILURE=1008
RNGP_DATA_CONTENT=1009
RNGP_DEF_CHOICE_AND_INTERLEAVE=1010
RNGP_DEFINE_CREATE_FAILED=1011
RNGP_DEFINE_EMPTY=1012
RNGP_DEFINE_MISSING=1013
RNGP_DEFINE_NAME_MISSING=1014
RNGP_ELEM_CONTENT_EMPTY=1015
RNGP_ELEM_CONTENT_ERROR=1016
RNGP_ELEMENT_EMPTY=1017
RNGP_ELEMENT_CONTENT=1018
RNGP_ELEMENT_NAME=1019
RNGP_ELEMENT_NO_CONTENT=1020
RNGP_ELEM_TEXT_CONFLICT=1021
RNGP_EMPTY=1022
RNGP_EMPTY_CONSTRUCT=1023
RNGP_EMPTY_CONTENT=1024
RNGP_EMPTY_NOT_EMPTY=1025
RNGP_ERROR_TYPE_LIB=1026
RNGP_EXCEPT_EMPTY=1027
RNGP_EXCEPT_MISSING=1028
RNGP_EXCEPT_MULTIPLE=1029
RNGP_EXCEPT_NO_CONTENT=1030
RNGP_EXTERNALREF_EMTPY=1031
RNGP_EXTERNAL_REF_FAILURE=1032
RNGP_EXTERNALREF_RECURSE=1033
RNGP_FORBIDDEN_ATTRIBUTE=1034
RNGP_FOREIGN_ELEMENT=1035
RNGP_GRAMMAR_CONTENT=1036
RNGP_GRAMMAR_EMPTY=1037
RNGP_GRAMMAR_MISSING=1038
RNGP_GRAMMAR_NO_START=1039
RNGP_GROUP_ATTR_CONFLICT=1040
RNGP_HREF_ERROR=1041
RNGP_INCLUDE_EMPTY=1042
RNGP_INCLUDE_FAILURE=1043
RNGP_INCLUDE_RECURSE=1044
RNGP_INTERLEAVE_ADD=1045
RNGP_INTERLEAVE_CREATE_FAILED=1046
RNGP_INTERLEAVE_EMPTY=1047
RNGP_INTERLEAVE_NO_CONTENT=1048
RNGP_INVALID_DEFINE_NAME=1049
RNGP_INVALID_URI=1050
RNGP_INVALID_VALUE=1051
RNGP_MISSING_HREF=1052
RNGP_NAME_MISSING=1053
RNGP_NEED_COMBINE=1054
RNGP_NOTALLOWED_NOT_EMPTY=1055
RNGP_NSNAME_ATTR_ANCESTOR=1056
RNGP_NSNAME_NO_NS=1057
RNGP_PARAM_FORBIDDEN=1058
RNGP_PARAM_NAME_MISSING=1059
RNGP_PARENTREF_CREATE_FAILED=1060
RNGP_PARENTREF_NAME_INVALID=1061
RNGP_PARENTREF_NO_NAME=1062
RNGP_PARENTREF_NO_PARENT=1063
RNGP_PARENTREF_NOT_EMPTY=1064
RNGP_PARSE_ERROR=1065
RNGP_PAT_ANYNAME_EXCEPT_ANYNAME=1066
RNGP_PAT_ATTR_ATTR=1067
RNGP_PAT_ATTR_ELEM=1068
RNGP_PAT_DATA_EXCEPT_ATTR=1069
RNGP_PAT_DATA_EXCEPT_ELEM=1070
RNGP_PAT_DATA_EXCEPT_EMPTY=1071
RNGP_PAT_DATA_EXCEPT_GROUP=1072
RNGP_PAT_DATA_EXCEPT_INTERLEAVE=1073
RNGP_PAT_DATA_EXCEPT_LIST=1074
RNGP_PAT_DATA_EXCEPT_ONEMORE=1075
RNGP_PAT_DATA_EXCEPT_REF=1076
RNGP_PAT_DATA_EXCEPT_TEXT=1077
RNGP_PAT_LIST_ATTR=1078
RNGP_PAT_LIST_ELEM=1079
RNGP_PAT_LIST_INTERLEAVE=1080
RNGP_PAT_LIST_LIST=1081
RNGP_PAT_LIST_REF=1082
RNGP_PAT_LIST_TEXT=1083
RNGP_PAT_NSNAME_EXCEPT_ANYNAME=1084
RNGP_PAT_NSNAME_EXCEPT_NSNAME=1085
RNGP_PAT_ONEMORE_GROUP_ATTR=1086
RNGP_PAT_ONEMORE_INTERLEAVE_ATTR=1087
RNGP_PAT_START_ATTR=1088
RNGP_PAT_START_DATA=1089
RNGP_PAT_START_EMPTY=1090
RNGP_PAT_START_GROUP=1091
RNGP_PAT_START_INTERLEAVE=1092
RNGP_PAT_START_LIST=1093
RNGP_PAT_START_ONEMORE=1094
RNGP_PAT_START_TEXT=1095
RNGP_PAT_START_VALUE=1096
RNGP_PREFIX_UNDEFINED=1097
RNGP_REF_CREATE_FAILED=1098
RNGP_REF_CYCLE=1099
RNGP_REF_NAME_INVALID=1100
RNGP_REF_NO_DEF=1101
RNGP_REF_NO_NAME=1102
RNGP_REF_NOT_EMPTY=1103
RNGP_START_CHOICE_AND_INTERLEAVE=1104
RNGP_START_CONTENT=1105
RNGP_START_EMPTY=1106
RNGP_START_MISSING=1107
RNGP_TEXT_EXPECTED=1108
RNGP_TEXT_HAS_CHILD=1109
RNGP_TYPE_MISSING=1110
RNGP_TYPE_NOT_FOUND=1111
RNGP_TYPE_VALUE=1112
RNGP_UNKNOWN_ATTRIBUTE=1113
RNGP_UNKNOWN_COMBINE=1114
RNGP_UNKNOWN_CONSTRUCT=1115
RNGP_UNKNOWN_TYPE_LIB=1116
RNGP_URI_FRAGMENT=1117
RNGP_URI_NOT_ABSOLUTE=1118
RNGP_VALUE_EMPTY=1119
RNGP_VALUE_NO_CONTENT=1120
RNGP_XMLNS_NAME=1121
RNGP_XML_NS=1122
XPATH_EXPRESSION_OK=1200
XPATH_NUMBER_ERROR=1201
XPATH_UNFINISHED_LITERAL_ERROR=1202
XPATH_START_LITERAL_ERROR=1203
XPATH_VARIABLE_REF_ERROR=1204
XPATH_UNDEF_VARIABLE_ERROR=1205
XPATH_INVALID_PREDICATE_ERROR=1206
XPATH_EXPR_ERROR=1207
XPATH_UNCLOSED_ERROR=1208
XPATH_UNKNOWN_FUNC_ERROR=1209
XPATH_INVALID_OPERAND=1210
XPATH_INVALID_TYPE=1211
XPATH_INVALID_ARITY=1212
XPATH_INVALID_CTXT_SIZE=1213
XPATH_INVALID_CTXT_POSITION=1214
XPATH_MEMORY_ERROR=1215
XPTR_SYNTAX_ERROR=1216
XPTR_RESOURCE_ERROR=1217
XPTR_SUB_RESOURCE_ERROR=1218
XPATH_UNDEF_PREFIX_ERROR=1219
XPATH_ENCODING_ERROR=1220
XPATH_INVALID_CHAR_ERROR=1221
TREE_INVALID_HEX=1300
TREE_INVALID_DEC=1301
TREE_UNTERMINATED_ENTITY=1302
TREE_NOT_UTF8=1303
SAVE_NOT_UTF8=1400
SAVE_CHAR_INVALID=1401
SAVE_NO_DOCTYPE=1402
SAVE_UNKNOWN_ENCODING=1403
REGEXP_COMPILE_ERROR=1450
IO_UNKNOWN=1500
IO_EACCES=1501
IO_EAGAIN=1502
IO_EBADF=1503
IO_EBADMSG=1504
IO_EBUSY=1505
IO_ECANCELED=1506
IO_ECHILD=1507
IO_EDEADLK=1508
IO_EDOM=1509
IO_EEXIST=1510
IO_EFAULT=1511
IO_EFBIG=1512
IO_EINPROGRESS=1513
IO_EINTR=1514
IO_EINVAL=1515
IO_EIO=1516
IO_EISDIR=1517
IO_EMFILE=1518
IO_EMLINK=1519
IO_EMSGSIZE=1520
IO_ENAMETOOLONG=1521
IO_ENFILE=1522
IO_ENODEV=1523
IO_ENOENT=1524
IO_ENOEXEC=1525
IO_ENOLCK=1526
IO_ENOMEM=1527
IO_ENOSPC=1528
IO_ENOSYS=1529
IO_ENOTDIR=1530
IO_ENOTEMPTY=1531
IO_ENOTSUP=1532
IO_ENOTTY=1533
IO_ENXIO=1534
IO_EPERM=1535
IO_EPIPE=1536
IO_ERANGE=1537
IO_EROFS=1538
IO_ESPIPE=1539
IO_ESRCH=1540
IO_ETIMEDOUT=1541
IO_EXDEV=1542
IO_NETWORK_ATTEMPT=1543
IO_ENCODER=1544
IO_FLUSH=1545
IO_WRITE=1546
IO_NO_INPUT=1547
IO_BUFFER_FULL=1548
IO_LOAD_ERROR=1549
IO_ENOTSOCK=1550
IO_EISCONN=1551
IO_ECONNREFUSED=1552
IO_ENETUNREACH=1553
IO_EADDRINUSE=1554
IO_EALREADY=1555
IO_EAFNOSUPPORT=1556
IO_UNSUPPORTED_PROTOCOL=1557
XINCLUDE_RECURSION=1600
XINCLUDE_PARSE_VALUE=1601
XINCLUDE_ENTITY_DEF_MISMATCH=1602
XINCLUDE_NO_HREF=1603
XINCLUDE_NO_FALLBACK=1604
XINCLUDE_HREF_URI=1605
XINCLUDE_TEXT_FRAGMENT=1606
XINCLUDE_TEXT_DOCUMENT=1607
XINCLUDE_INVALID_CHAR=1608
XINCLUDE_BUILD_FAILED=1609
XINCLUDE_UNKNOWN_ENCODING=1610
XINCLUDE_MULTIPLE_ROOT=1611
XINCLUDE_XPTR_FAILED=1612
XINCLUDE_XPTR_RESULT=1613
XINCLUDE_INCLUDE_IN_INCLUDE=1614
XINCLUDE_FALLBACKS_IN_INCLUDE=1615
XINCLUDE_FALLBACK_NOT_IN_INCLUDE=1616
XINCLUDE_DEPRECATED_NS=1617
XINCLUDE_FRAGMENT_ID=1618
CATALOG_MISSING_ATTR=1650
CATALOG_ENTRY_BROKEN=1651
CATALOG_PREFER_VALUE=1652
CATALOG_NOT_CATALOG=1653
CATALOG_RECURSION=1654
SCHEMAP_PREFIX_UNDEFINED=1700
SCHEMAP_ATTRFORMDEFAULT_VALUE=1701
SCHEMAP_ATTRGRP_NONAME_NOREF=1702
SCHEMAP_ATTR_NONAME_NOREF=1703
SCHEMAP_COMPLEXTYPE_NONAME_NOREF=1704
SCHEMAP_ELEMFORMDEFAULT_VALUE=1705
SCHEMAP_ELEM_NONAME_NOREF=1706
SCHEMAP_EXTENSION_NO_BASE=1707
SCHEMAP_FACET_NO_VALUE=1708
SCHEMAP_FAILED_BUILD_IMPORT=1709
SCHEMAP_GROUP_NONAME_NOREF=1710
SCHEMAP_IMPORT_NAMESPACE_NOT_URI=1711
SCHEMAP_IMPORT_REDEFINE_NSNAME=1712
SCHEMAP_IMPORT_SCHEMA_NOT_URI=1713
SCHEMAP_INVALID_BOOLEAN=1714
SCHEMAP_INVALID_ENUM=1715
SCHEMAP_INVALID_FACET=1716
SCHEMAP_INVALID_FACET_VALUE=1717
SCHEMAP_INVALID_MAXOCCURS=1718
SCHEMAP_INVALID_MINOCCURS=1719
SCHEMAP_INVALID_REF_AND_SUBTYPE=1720
SCHEMAP_INVALID_WHITE_SPACE=1721
SCHEMAP_NOATTR_NOREF=1722
SCHEMAP_NOTATION_NO_NAME=1723
SCHEMAP_NOTYPE_NOREF=1724
SCHEMAP_REF_AND_SUBTYPE=1725
SCHEMAP_RESTRICTION_NONAME_NOREF=1726
SCHEMAP_SIMPLETYPE_NONAME=1727
SCHEMAP_TYPE_AND_SUBTYPE=1728
SCHEMAP_UNKNOWN_ALL_CHILD=1729
SCHEMAP_UNKNOWN_ANYATTRIBUTE_CHILD=1730
SCHEMAP_UNKNOWN_ATTR_CHILD=1731
SCHEMAP_UNKNOWN_ATTRGRP_CHILD=1732
SCHEMAP_UNKNOWN_ATTRIBUTE_GROUP=1733
SCHEMAP_UNKNOWN_BASE_TYPE=1734
SCHEMAP_UNKNOWN_CHOICE_CHILD=1735
SCHEMAP_UNKNOWN_COMPLEXCONTENT_CHILD=1736
SCHEMAP_UNKNOWN_COMPLEXTYPE_CHILD=1737
SCHEMAP_UNKNOWN_ELEM_CHILD=1738
SCHEMAP_UNKNOWN_EXTENSION_CHILD=1739
SCHEMAP_UNKNOWN_FACET_CHILD=1740
SCHEMAP_UNKNOWN_FACET_TYPE=1741
SCHEMAP_UNKNOWN_GROUP_CHILD=1742
SCHEMAP_UNKNOWN_IMPORT_CHILD=1743
SCHEMAP_UNKNOWN_LIST_CHILD=1744
SCHEMAP_UNKNOWN_NOTATION_CHILD=1745
SCHEMAP_UNKNOWN_PROCESSCONTENT_CHILD=1746
SCHEMAP_UNKNOWN_REF=1747
SCHEMAP_UNKNOWN_RESTRICTION_CHILD=1748
SCHEMAP_UNKNOWN_SCHEMAS_CHILD=1749
SCHEMAP_UNKNOWN_SEQUENCE_CHILD=1750
SCHEMAP_UNKNOWN_SIMPLECONTENT_CHILD=1751
SCHEMAP_UNKNOWN_SIMPLETYPE_CHILD=1752
SCHEMAP_UNKNOWN_TYPE=1753
SCHEMAP_UNKNOWN_UNION_CHILD=1754
SCHEMAP_ELEM_DEFAULT_FIXED=1755
SCHEMAP_REGEXP_INVALID=1756
SCHEMAP_FAILED_LOAD=1757
SCHEMAP_NOTHING_TO_PARSE=1758
SCHEMAP_NOROOT=1759
SCHEMAP_REDEFINED_GROUP=1760
SCHEMAP_REDEFINED_TYPE=1761
SCHEMAP_REDEFINED_ELEMENT=1762
SCHEMAP_REDEFINED_ATTRGROUP=1763
SCHEMAP_REDEFINED_ATTR=1764
SCHEMAP_REDEFINED_NOTATION=1765
SCHEMAP_FAILED_PARSE=1766
SCHEMAP_UNKNOWN_PREFIX=1767
SCHEMAP_DEF_AND_PREFIX=1768
SCHEMAP_UNKNOWN_INCLUDE_CHILD=1769
SCHEMAP_INCLUDE_SCHEMA_NOT_URI=1770
SCHEMAP_INCLUDE_SCHEMA_NO_URI=1771
SCHEMAP_NOT_SCHEMA=1772
SCHEMAP_UNKNOWN_MEMBER_TYPE=1773
SCHEMAP_INVALID_ATTR_USE=1774
SCHEMAP_RECURSIVE=1775
SCHEMAP_SUPERNUMEROUS_LIST_ITEM_TYPE=1776
SCHEMAP_INVALID_ATTR_COMBINATION=1777
SCHEMAP_INVALID_ATTR_INLINE_COMBINATION=1778
SCHEMAP_MISSING_SIMPLETYPE_CHILD=1779
SCHEMAP_INVALID_ATTR_NAME=1780
SCHEMAP_REF_AND_CONTENT=1781
SCHEMAP_CT_PROPS_CORRECT_1=1782
SCHEMAP_CT_PROPS_CORRECT_2=1783
SCHEMAP_CT_PROPS_CORRECT_3=1784
SCHEMAP_CT_PROPS_CORRECT_4=1785
SCHEMAP_CT_PROPS_CORRECT_5=1786
SCHEMAP_DERIVATION_OK_RESTRICTION_1=1787
SCHEMAP_DERIVATION_OK_RESTRICTION_2_1_1=1788
SCHEMAP_DERIVATION_OK_RESTRICTION_2_1_2=1789
SCHEMAP_DERIVATION_OK_RESTRICTION_2_2=1790
SCHEMAP_DERIVATION_OK_RESTRICTION_3=1791
SCHEMAP_WILDCARD_INVALID_NS_MEMBER=1792
SCHEMAP_INTERSECTION_NOT_EXPRESSIBLE=1793
SCHEMAP_UNION_NOT_EXPRESSIBLE=1794
SCHEMAP_SRC_IMPORT_3_1=1795
SCHEMAP_SRC_IMPORT_3_2=1796
SCHEMAP_DERIVATION_OK_RESTRICTION_4_1=1797
SCHEMAP_DERIVATION_OK_RESTRICTION_4_2=1798
SCHEMAP_DERIVATION_OK_RESTRICTION_4_3=1799
SCHEMAP_COS_CT_EXTENDS_1_3=1800
SCHEMAV_NOROOT=1801
SCHEMAV_UNDECLAREDELEM=1802
SCHEMAV_NOTTOPLEVEL=1803
SCHEMAV_MISSING=1804
SCHEMAV_WRONGELEM=1805
SCHEMAV_NOTYPE=1806
SCHEMAV_NOROLLBACK=1807
SCHEMAV_ISABSTRACT=1808
SCHEMAV_NOTEMPTY=1809
SCHEMAV_ELEMCONT=1810
SCHEMAV_HAVEDEFAULT=1811
SCHEMAV_NOTNILLABLE=1812
SCHEMAV_EXTRACONTENT=1813
SCHEMAV_INVALIDATTR=1814
SCHEMAV_INVALIDELEM=1815
SCHEMAV_NOTDETERMINIST=1816
SCHEMAV_CONSTRUCT=1817
SCHEMAV_INTERNAL=1818
SCHEMAV_NOTSIMPLE=1819
SCHEMAV_ATTRUNKNOWN=1820
SCHEMAV_ATTRINVALID=1821
SCHEMAV_VALUE=1822
SCHEMAV_FACET=1823
SCHEMAV_CVC_DATATYPE_VALID_1_2_1=1824
SCHEMAV_CVC_DATATYPE_VALID_1_2_2=1825
SCHEMAV_CVC_DATATYPE_VALID_1_2_3=1826
SCHEMAV_CVC_TYPE_3_1_1=1827
SCHEMAV_CVC_TYPE_3_1_2=1828
SCHEMAV_CVC_FACET_VALID=1829
SCHEMAV_CVC_LENGTH_VALID=1830
SCHEMAV_CVC_MINLENGTH_VALID=1831
SCHEMAV_CVC_MAXLENGTH_VALID=1832
SCHEMAV_CVC_MININCLUSIVE_VALID=1833
SCHEMAV_CVC_MAXINCLUSIVE_VALID=1834
SCHEMAV_CVC_MINEXCLUSIVE_VALID=1835
SCHEMAV_CVC_MAXEXCLUSIVE_VALID=1836
SCHEMAV_CVC_TOTALDIGITS_VALID=1837
SCHEMAV_CVC_FRACTIONDIGITS_VALID=1838
SCHEMAV_CVC_PATTERN_VALID=1839
SCHEMAV_CVC_ENUMERATION_VALID=1840
SCHEMAV_CVC_COMPLEX_TYPE_2_1=1841
SCHEMAV_CVC_COMPLEX_TYPE_2_2=1842
SCHEMAV_CVC_COMPLEX_TYPE_2_3=1843
SCHEMAV_CVC_COMPLEX_TYPE_2_4=1844
SCHEMAV_CVC_ELT_1=1845
SCHEMAV_CVC_ELT_2=1846
SCHEMAV_CVC_ELT_3_1=1847
SCHEMAV_CVC_ELT_3_2_1=1848
SCHEMAV_CVC_ELT_3_2_2=1849
SCHEMAV_CVC_ELT_4_1=1850
SCHEMAV_CVC_ELT_4_2=1851
SCHEMAV_CVC_ELT_4_3=1852
SCHEMAV_CVC_ELT_5_1_1=1853
SCHEMAV_CVC_ELT_5_1_2=1854
SCHEMAV_CVC_ELT_5_2_1=1855
SCHEMAV_CVC_ELT_5_2_2_1=1856
SCHEMAV_CVC_ELT_5_2_2_2_1=1857
SCHEMAV_CVC_ELT_5_2_2_2_2=1858
SCHEMAV_CVC_ELT_6=1859
SCHEMAV_CVC_ELT_7=1860
SCHEMAV_CVC_ATTRIBUTE_1=1861
SCHEMAV_CVC_ATTRIBUTE_2=1862
SCHEMAV_CVC_ATTRIBUTE_3=1863
SCHEMAV_CVC_ATTRIBUTE_4=1864
SCHEMAV_CVC_COMPLEX_TYPE_3_1=1865
SCHEMAV_CVC_COMPLEX_TYPE_3_2_1=1866
SCHEMAV_CVC_COMPLEX_TYPE_3_2_2=1867
SCHEMAV_CVC_COMPLEX_TYPE_4=1868
SCHEMAV_CVC_COMPLEX_TYPE_5_1=1869
SCHEMAV_CVC_COMPLEX_TYPE_5_2=1870
SCHEMAV_ELEMENT_CONTENT=1871
SCHEMAV_DOCUMENT_ELEMENT_MISSING=1872
SCHEMAV_CVC_COMPLEX_TYPE_1=1873
SCHEMAV_CVC_AU=1874
SCHEMAV_CVC_TYPE_1=1875
SCHEMAV_CVC_TYPE_2=1876
SCHEMAV_CVC_IDC=1877
SCHEMAV_CVC_WILDCARD=1878
SCHEMAV_MISC=1879
XPTR_UNKNOWN_SCHEME=1900
XPTR_CHILDSEQ_START=1901
XPTR_EVAL_FAILED=1902
XPTR_EXTRA_OBJECTS=1903
C14N_CREATE_CTXT=1950
C14N_REQUIRES_UTF8=1951
C14N_CREATE_STACK=1952
C14N_INVALID_NODE=1953
C14N_UNKNOW_NODE=1954
C14N_RELATIVE_NAMESPACE=1955
FTP_PASV_ANSWER=2000
FTP_EPSV_ANSWER=2001
FTP_ACCNT=2002
FTP_URL_SYNTAX=2003
HTTP_URL_SYNTAX=2020
HTTP_USE_IP=2021
HTTP_UNKNOWN_HOST=2022
SCHEMAP_SRC_SIMPLE_TYPE_1=3000
SCHEMAP_SRC_SIMPLE_TYPE_2=3001
SCHEMAP_SRC_SIMPLE_TYPE_3=3002
SCHEMAP_SRC_SIMPLE_TYPE_4=3003
SCHEMAP_SRC_RESOLVE=3004
SCHEMAP_SRC_RESTRICTION_BASE_OR_SIMPLETYPE=3005
SCHEMAP_SRC_LIST_ITEMTYPE_OR_SIMPLETYPE=3006
SCHEMAP_SRC_UNION_MEMBERTYPES_OR_SIMPLETYPES=3007
SCHEMAP_ST_PROPS_CORRECT_1=3008
SCHEMAP_ST_PROPS_CORRECT_2=3009
SCHEMAP_ST_PROPS_CORRECT_3=3010
SCHEMAP_COS_ST_RESTRICTS_1_1=3011
SCHEMAP_COS_ST_RESTRICTS_1_2=3012
SCHEMAP_COS_ST_RESTRICTS_1_3_1=3013
SCHEMAP_COS_ST_RESTRICTS_1_3_2=3014
SCHEMAP_COS_ST_RESTRICTS_2_1=3015
SCHEMAP_COS_ST_RESTRICTS_2_3_1_1=3016
SCHEMAP_COS_ST_RESTRICTS_2_3_1_2=3017
SCHEMAP_COS_ST_RESTRICTS_2_3_2_1=3018
SCHEMAP_COS_ST_RESTRICTS_2_3_2_2=3019
SCHEMAP_COS_ST_RESTRICTS_2_3_2_3=3020
SCHEMAP_COS_ST_RESTRICTS_2_3_2_4=3021
SCHEMAP_COS_ST_RESTRICTS_2_3_2_5=3022
SCHEMAP_COS_ST_RESTRICTS_3_1=3023
SCHEMAP_COS_ST_RESTRICTS_3_3_1=3024
SCHEMAP_COS_ST_RESTRICTS_3_3_1_2=3025
SCHEMAP_COS_ST_RESTRICTS_3_3_2_2=3026
SCHEMAP_COS_ST_RESTRICTS_3_3_2_1=3027
SCHEMAP_COS_ST_RESTRICTS_3_3_2_3=3028
SCHEMAP_COS_ST_RESTRICTS_3_3_2_4=3029
SCHEMAP_COS_ST_RESTRICTS_3_3_2_5=3030
SCHEMAP_COS_ST_DERIVED_OK_2_1=3031
SCHEMAP_COS_ST_DERIVED_OK_2_2=3032
SCHEMAP_S4S_ELEM_NOT_ALLOWED=3033
SCHEMAP_S4S_ELEM_MISSING=3034
SCHEMAP_S4S_ATTR_NOT_ALLOWED=3035
SCHEMAP_S4S_ATTR_MISSING=3036
SCHEMAP_S4S_ATTR_INVALID_VALUE=3037
SCHEMAP_SRC_ELEMENT_1=3038
SCHEMAP_SRC_ELEMENT_2_1=3039
SCHEMAP_SRC_ELEMENT_2_2=3040
SCHEMAP_SRC_ELEMENT_3=3041
SCHEMAP_P_PROPS_CORRECT_1=3042
SCHEMAP_P_PROPS_CORRECT_2_1=3043
SCHEMAP_P_PROPS_CORRECT_2_2=3044
SCHEMAP_E_PROPS_CORRECT_2=3045
SCHEMAP_E_PROPS_CORRECT_3=3046
SCHEMAP_E_PROPS_CORRECT_4=3047
SCHEMAP_E_PROPS_CORRECT_5=3048
SCHEMAP_E_PROPS_CORRECT_6=3049
SCHEMAP_SRC_INCLUDE=3050
SCHEMAP_SRC_ATTRIBUTE_1=3051
SCHEMAP_SRC_ATTRIBUTE_2=3052
SCHEMAP_SRC_ATTRIBUTE_3_1=3053
SCHEMAP_SRC_ATTRIBUTE_3_2=3054
SCHEMAP_SRC_ATTRIBUTE_4=3055
SCHEMAP_NO_XMLNS=3056
SCHEMAP_NO_XSI=3057
SCHEMAP_COS_VALID_DEFAULT_1=3058
SCHEMAP_COS_VALID_DEFAULT_2_1=3059
SCHEMAP_COS_VALID_DEFAULT_2_2_1=3060
SCHEMAP_COS_VALID_DEFAULT_2_2_2=3061
SCHEMAP_CVC_SIMPLE_TYPE=3062
SCHEMAP_COS_CT_EXTENDS_1_1=3063
SCHEMAP_SRC_IMPORT_1_1=3064
SCHEMAP_SRC_IMPORT_1_2=3065
SCHEMAP_SRC_IMPORT_2=3066
SCHEMAP_SRC_IMPORT_2_1=3067
SCHEMAP_SRC_IMPORT_2_2=3068
SCHEMAP_INTERNAL=3069
SCHEMAP_NOT_DETERMINISTIC=3070
SCHEMAP_SRC_ATTRIBUTE_GROUP_1=3071
SCHEMAP_SRC_ATTRIBUTE_GROUP_2=3072
SCHEMAP_SRC_ATTRIBUTE_GROUP_3=3073
SCHEMAP_MG_PROPS_CORRECT_1=3074
SCHEMAP_MG_PROPS_CORRECT_2=3075
SCHEMAP_SRC_CT_1=3076
SCHEMAP_DERIVATION_OK_RESTRICTION_2_1_3=3077
SCHEMAP_AU_PROPS_CORRECT_2=3078
SCHEMAP_A_PROPS_CORRECT_2=3079
SCHEMAP_C_PROPS_CORRECT=3080
SCHEMAP_SRC_REDEFINE=3081
SCHEMAP_SRC_IMPORT=3082
SCHEMAP_WARN_SKIP_SCHEMA=3083
SCHEMAP_WARN_UNLOCATED_SCHEMA=3084
SCHEMAP_WARN_ATTR_REDECL_PROH=3085
SCHEMAP_WARN_ATTR_POINTLESS_PROH=3086
SCHEMAP_AG_PROPS_CORRECT=3087
SCHEMAP_COS_CT_EXTENDS_1_2=3088
SCHEMAP_AU_PROPS_CORRECT=3089
SCHEMAP_A_PROPS_CORRECT_3=3090
SCHEMAP_COS_ALL_LIMITED=3091
SCHEMATRONV_ASSERT=4000
SCHEMATRONV_REPORT=4001
MODULE_OPEN=4900
MODULE_CLOSE=4901
CHECK_FOUND_ELEMENT=5000
CHECK_FOUND_ATTRIBUTE=5001
CHECK_FOUND_TEXT=5002
CHECK_FOUND_CDATA=5003
CHECK_FOUND_ENTITYREF=5004
CHECK_FOUND_ENTITY=5005
CHECK_FOUND_PI=5006
CHECK_FOUND_COMMENT=5007
CHECK_FOUND_DOCTYPE=5008
CHECK_FOUND_FRAGMENT=5009
CHECK_FOUND_NOTATION=5010
CHECK_UNKNOWN_NODE=5011
CHECK_ENTITY_TYPE=5012
CHECK_NO_PARENT=5013
CHECK_NO_DOC=5014
CHECK_NO_NAME=5015
CHECK_NO_ELEM=5016
CHECK_WRONG_DOC=5017
CHECK_NO_PREV=5018
CHECK_WRONG_PREV=5019
CHECK_NO_NEXT=5020
CHECK_WRONG_NEXT=5021
CHECK_NOT_DTD=5022
CHECK_NOT_ATTR=5023
CHECK_NOT_ATTR_DECL=5024
CHECK_NOT_ELEM_DECL=5025
CHECK_NOT_ENTITY_DECL=5026
CHECK_NOT_NS_DECL=5027
CHECK_NO_HREF=5028
CHECK_WRONG_PARENT=5029
CHECK_NS_SCOPE=5030
CHECK_NS_ANCESTOR=5031
CHECK_NOT_UTF8=5032
CHECK_NO_DICT=5033
CHECK_NOT_NCNAME=5034
CHECK_OUTSIDE_DICT=5035
CHECK_WRONG_NAME=5036
CHECK_NAME_NOT_NULL=5037
I18N_NO_NAME=6000
I18N_NO_HANDLER=6001
I18N_EXCESS_HANDLER=6002
I18N_CONV_FAILED=6003
I18N_NO_OUTPUT=6004
BUF_OVERFLOW=7000
"""

cdef object __RELAXNG_ERROR_TYPES = """\
RELAXNG_OK=0
RELAXNG_ERR_MEMORY=1
RELAXNG_ERR_TYPE=2
RELAXNG_ERR_TYPEVAL=3
RELAXNG_ERR_DUPID=4
RELAXNG_ERR_TYPECMP=5
RELAXNG_ERR_NOSTATE=6
RELAXNG_ERR_NODEFINE=7
RELAXNG_ERR_LISTEXTRA=8
RELAXNG_ERR_LISTEMPTY=9
RELAXNG_ERR_INTERNODATA=10
RELAXNG_ERR_INTERSEQ=11
RELAXNG_ERR_INTEREXTRA=12
RELAXNG_ERR_ELEMNAME=13
RELAXNG_ERR_ATTRNAME=14
RELAXNG_ERR_ELEMNONS=15
RELAXNG_ERR_ATTRNONS=16
RELAXNG_ERR_ELEMWRONGNS=17
RELAXNG_ERR_ATTRWRONGNS=18
RELAXNG_ERR_ELEMEXTRANS=19
RELAXNG_ERR_ATTREXTRANS=20
RELAXNG_ERR_ELEMNOTEMPTY=21
RELAXNG_ERR_NOELEM=22
RELAXNG_ERR_NOTELEM=23
RELAXNG_ERR_ATTRVALID=24
RELAXNG_ERR_CONTENTVALID=25
RELAXNG_ERR_EXTRACONTENT=26
RELAXNG_ERR_INVALIDATTR=27
RELAXNG_ERR_DATAELEM=28
RELAXNG_ERR_VALELEM=29
RELAXNG_ERR_LISTELEM=30
RELAXNG_ERR_DATATYPE=31
RELAXNG_ERR_VALUE=32
RELAXNG_ERR_LIST=33
RELAXNG_ERR_NOGRAMMAR=34
RELAXNG_ERR_EXTRADATA=35
RELAXNG_ERR_LACKDATA=36
RELAXNG_ERR_INTERNAL=37
RELAXNG_ERR_ELEMWRONG=38
RELAXNG_ERR_TEXTWRONG=39
"""
# --- END: GENERATED CONSTANTS ---

__initErrorConstants()
