# XInclude processing

from lxml.includes cimport xinclude


cdef class XIncludeError(LxmlError):
    """Error during XInclude processing.
    """


cdef class XInclude:
    """XInclude(self)
    XInclude processor.

    Create an instance and call it on an Element to run XInclude
    processing.
    """
    cdef _ErrorLog _error_log
    def __init__(self):
        self._error_log = _ErrorLog()

    @property
    def error_log(self):
        assert self._error_log is not None, "XInclude instance not initialised"
        return self._error_log.copy()

    def __call__(self, _Element node not None):
        "__call__(self, node)"
        # We cannot pass the XML_PARSE_NOXINCNODE option as this would free
        # the XInclude nodes - there may still be Python references to them!
        # Therefore, we allow XInclude nodes to be converted to
        # XML_XINCLUDE_START nodes.  XML_XINCLUDE_END nodes are added as
        # siblings.  Tree traversal will simply ignore them as they are not
        # typed as elements.  The included fragment is added between the two,
        # i.e. as a sibling, which does not conflict with traversal.
        cdef int result
        _assertValidNode(node)
        assert self._error_log is not None, "XInclude processor not initialised"
        if node._doc._parser is not None:
            parse_options = node._doc._parser._parse_options
            context = node._doc._parser._getParserContext()
            c_context = <void*>context
        else:
            parse_options = 0
            context = None
            c_context = NULL

        self._error_log.connect()
        if tree.LIBXML_VERSION < 20704 or not c_context:
            __GLOBAL_PARSER_CONTEXT.pushImpliedContext(context)
        with nogil:
            orig_loader = _register_document_loader()
            if c_context:
                result = xinclude.xmlXIncludeProcessTreeFlagsData(
                    node._c_node, parse_options, c_context)
            else:
                result = xinclude.xmlXIncludeProcessTree(node._c_node)
            _reset_document_loader(orig_loader)
        if tree.LIBXML_VERSION < 20704 or not c_context:
            __GLOBAL_PARSER_CONTEXT.popImpliedContext()
        self._error_log.disconnect()

        if result == -1:
            raise XIncludeError(
                self._error_log._buildExceptionMessage(
                    "XInclude processing failed"),
                self._error_log)
