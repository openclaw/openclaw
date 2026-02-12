# Parser target context (ET target interface)

cdef object inspect_getargspec
try:
    from inspect import getfullargspec as inspect_getargspec
except ImportError:
    from inspect import getargspec as inspect_getargspec


class _TargetParserResult(Exception):
    # Admittedly, this is somewhat ugly, but it's the easiest way
    # to push the Python level parser result through the parser
    # machinery towards the API level functions
    def __init__(self, result):
        self.result = result


@cython.final
@cython.internal
cdef class _PythonSaxParserTarget(_SaxParserTarget):
    cdef object _target_start
    cdef object _target_end
    cdef object _target_data
    cdef object _target_start_ns
    cdef object _target_end_ns
    cdef object _target_doctype
    cdef object _target_pi
    cdef object _target_comment
    cdef bint _start_takes_nsmap

    def __cinit__(self, target):
        cdef int event_filter
        event_filter = 0
        self._start_takes_nsmap = 0
        try:
            self._target_start = target.start
            if self._target_start is not None:
                event_filter |= SAX_EVENT_START
        except AttributeError:
            pass
        else:
            try:
                arguments = inspect_getargspec(self._target_start)
                if len(arguments[0]) > 3 or arguments[1] is not None:
                    self._start_takes_nsmap = 1
            except TypeError:
                pass
        try:
            self._target_end = target.end
            if self._target_end is not None:
                event_filter |= SAX_EVENT_END
        except AttributeError:
            pass
        try:
            self._target_start_ns = target.start_ns
            if self._target_start_ns is not None:
                event_filter |= SAX_EVENT_START_NS
        except AttributeError:
            pass
        try:
            self._target_end_ns = target.end_ns
            if self._target_end_ns is not None:
                event_filter |= SAX_EVENT_END_NS
        except AttributeError:
            pass
        try:
            self._target_data = target.data
            if self._target_data is not None:
                event_filter |= SAX_EVENT_DATA
        except AttributeError:
            pass
        try:
            self._target_doctype = target.doctype
            if self._target_doctype is not None:
                event_filter |= SAX_EVENT_DOCTYPE
        except AttributeError:
            pass
        try:
            self._target_pi = target.pi
            if self._target_pi is not None:
                event_filter |= SAX_EVENT_PI
        except AttributeError:
            pass
        try:
            self._target_comment = target.comment
            if self._target_comment is not None:
                event_filter |= SAX_EVENT_COMMENT
        except AttributeError:
            pass
        self._sax_event_filter = event_filter

    cdef _handleSaxStart(self, tag, attrib, nsmap):
        if self._start_takes_nsmap:
            return self._target_start(tag, attrib, nsmap)
        else:
            return self._target_start(tag, attrib)

    cdef _handleSaxEnd(self, tag):
        return self._target_end(tag)

    cdef _handleSaxStartNs(self, prefix, uri):
        return self._target_start_ns(prefix, uri)

    cdef _handleSaxEndNs(self, prefix):
        return self._target_end_ns(prefix)

    cdef int _handleSaxData(self, data) except -1:
        self._target_data(data)

    cdef int _handleSaxDoctype(self, root_tag, public_id, system_id) except -1:
        self._target_doctype(root_tag, public_id, system_id)

    cdef _handleSaxPi(self, target, data):
        return self._target_pi(target, data)

    cdef _handleSaxComment(self, comment):
        return self._target_comment(comment)


@cython.final
@cython.internal
@cython.no_gc_clear  # Required because parent class uses it - Cython bug.
cdef class _TargetParserContext(_SaxParserContext):
    """This class maps SAX2 events to the ET parser target interface.
    """
    cdef object _python_target
    cdef int _setTarget(self, target) except -1:
        self._python_target = target
        if not isinstance(target, _SaxParserTarget) or \
                hasattr(target, '__dict__'):
            target = _PythonSaxParserTarget(target)
        self._setSaxParserTarget(target)
        return 0

    cdef _ParserContext _copy(self):
        cdef _TargetParserContext context
        context = _ParserContext._copy(self)
        context._setTarget(self._python_target)
        return context

    cdef void _cleanupTargetParserContext(self, xmlDoc* result) noexcept:
        if self._c_ctxt.myDoc is not NULL:
            if self._c_ctxt.myDoc is not result and \
                    self._c_ctxt.myDoc._private is NULL:
                # no _Document proxy => orphen
                tree.xmlFreeDoc(self._c_ctxt.myDoc)
            self._c_ctxt.myDoc = NULL

    cdef object _handleParseResult(self, _BaseParser parser, xmlDoc* result,
                                   filename):
        cdef bint recover
        recover = parser._parse_options & xmlparser.XML_PARSE_RECOVER
        try:
            if self._has_raised():
                self._cleanupTargetParserContext(result)
                self._raise_if_stored()
            if not self._c_ctxt.wellFormed and not recover:
                _raiseParseError(self._c_ctxt, filename, self._error_log)
        except:
            self._python_target.close()
            raise
        return self._python_target.close()

    cdef xmlDoc* _handleParseResultDoc(self, _BaseParser parser,
                                       xmlDoc* result, filename) except NULL:
        cdef bint recover
        recover = parser._parse_options & xmlparser.XML_PARSE_RECOVER
        if result is not NULL and result._private is NULL:
            # no _Document proxy => orphen
            tree.xmlFreeDoc(result)
        try:
            self._cleanupTargetParserContext(result)
            self._raise_if_stored()
            if not self._c_ctxt.wellFormed and not recover:
                _raiseParseError(self._c_ctxt, filename, self._error_log)
        except:
            self._python_target.close()
            raise
        parse_result = self._python_target.close()
        raise _TargetParserResult(parse_result)
