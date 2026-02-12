# XPath evaluation

class XPathSyntaxError(LxmlSyntaxError, XPathError):
    pass

################################################################################
# XPath

cdef object _XPATH_SYNTAX_ERRORS = (
    xmlerror.XML_XPATH_NUMBER_ERROR,
    xmlerror.XML_XPATH_UNFINISHED_LITERAL_ERROR,
    xmlerror.XML_XPATH_VARIABLE_REF_ERROR,
    xmlerror.XML_XPATH_INVALID_PREDICATE_ERROR,
    xmlerror.XML_XPATH_UNCLOSED_ERROR,
    xmlerror.XML_XPATH_INVALID_CHAR_ERROR
)

cdef object _XPATH_EVAL_ERRORS = (
    xmlerror.XML_XPATH_UNDEF_VARIABLE_ERROR,
    xmlerror.XML_XPATH_UNDEF_PREFIX_ERROR,
    xmlerror.XML_XPATH_UNKNOWN_FUNC_ERROR,
    xmlerror.XML_XPATH_INVALID_OPERAND,
    xmlerror.XML_XPATH_INVALID_TYPE,
    xmlerror.XML_XPATH_INVALID_ARITY,
    xmlerror.XML_XPATH_INVALID_CTXT_SIZE,
    xmlerror.XML_XPATH_INVALID_CTXT_POSITION
)

cdef int _register_xpath_function(void* ctxt, name_utf, ns_utf) noexcept:
    if ns_utf is None:
        return xpath.xmlXPathRegisterFunc(
            <xpath.xmlXPathContext*>ctxt, _xcstr(name_utf),
            _xpath_function_call)
    else:
        return xpath.xmlXPathRegisterFuncNS(
            <xpath.xmlXPathContext*>ctxt, _xcstr(name_utf), _xcstr(ns_utf),
            _xpath_function_call)

cdef int _unregister_xpath_function(void* ctxt, name_utf, ns_utf) noexcept:
    if ns_utf is None:
        return xpath.xmlXPathRegisterFunc(
            <xpath.xmlXPathContext*>ctxt, _xcstr(name_utf), NULL)
    else:
        return xpath.xmlXPathRegisterFuncNS(
            <xpath.xmlXPathContext*>ctxt, _xcstr(name_utf), _xcstr(ns_utf), NULL)


@cython.final
@cython.internal
cdef class _XPathContext(_BaseContext):
    cdef object _variables
    def __init__(self, namespaces, extensions, error_log, enable_regexp, variables,
                 build_smart_strings):
        self._variables = variables
        _BaseContext.__init__(self, namespaces, extensions, error_log, enable_regexp,
                              build_smart_strings)

    cdef set_context(self, xpath.xmlXPathContext* xpathCtxt):
        self._set_xpath_context(xpathCtxt)
        # This would be a good place to set up the XPath parser dict, but
        # we cannot use the current thread dict as we do not know which
        # thread will execute the XPath evaluator - so, no dict for now.
        self.registerLocalNamespaces()
        self.registerLocalFunctions(xpathCtxt, _register_xpath_function)

    cdef register_context(self, _Document doc):
        self._register_context(doc)
        self.registerGlobalNamespaces()
        self.registerGlobalFunctions(self._xpathCtxt, _register_xpath_function)
        self.registerExsltFunctions()
        if self._variables is not None:
            self.registerVariables(self._variables)

    cdef unregister_context(self):
        self.unregisterGlobalFunctions(
            self._xpathCtxt, _unregister_xpath_function)
        self.unregisterGlobalNamespaces()
        xpath.xmlXPathRegisteredVariablesCleanup(self._xpathCtxt)
        self._cleanup_context()

    cdef void registerExsltFunctions(self) noexcept:
        if xslt.LIBXSLT_VERSION < 10125:
            # we'd only execute dummy functions anyway
            return
        tree.xmlHashScan(
            self._xpathCtxt.nsHash, _registerExsltFunctionsForNamespaces,
            self._xpathCtxt)

    cdef registerVariables(self, variable_dict):
        for name, value in variable_dict.items():
            name_utf = self._to_utf(name)
            xpath.xmlXPathRegisterVariable(
                self._xpathCtxt, _xcstr(name_utf), _wrapXPathObject(value, None, None))

    cdef registerVariable(self, name, value):
        name_utf = self._to_utf(name)
        xpath.xmlXPathRegisterVariable(
            self._xpathCtxt, _xcstr(name_utf), _wrapXPathObject(value, None, None))


cdef void _registerExsltFunctionsForNamespaces(
        void* _c_href, void* _ctxt, const_xmlChar* c_prefix) noexcept:
    c_href = <const_xmlChar*> _c_href
    ctxt = <xpath.xmlXPathContext*> _ctxt

    if tree.xmlStrcmp(c_href, xslt.EXSLT_DATE_NAMESPACE) == 0:
        xslt.exsltDateXpathCtxtRegister(ctxt, c_prefix)
    elif tree.xmlStrcmp(c_href, xslt.EXSLT_SETS_NAMESPACE) == 0:
        xslt.exsltSetsXpathCtxtRegister(ctxt, c_prefix)
    elif tree.xmlStrcmp(c_href, xslt.EXSLT_MATH_NAMESPACE) == 0:
        xslt.exsltMathXpathCtxtRegister(ctxt, c_prefix)
    elif tree.xmlStrcmp(c_href, xslt.EXSLT_STRINGS_NAMESPACE) == 0:
        xslt.exsltStrXpathCtxtRegister(ctxt, c_prefix)


cdef class _XPathEvaluatorBase:
    cdef xpath.xmlXPathContext* _xpathCtxt
    cdef _XPathContext _context
    cdef python.PyThread_type_lock _eval_lock
    cdef _ErrorLog _error_log
    def __cinit__(self):
        self._xpathCtxt = NULL
        if config.ENABLE_THREADING:
            self._eval_lock = python.PyThread_allocate_lock()
            if self._eval_lock is NULL:
                raise MemoryError()
        self._error_log = _ErrorLog()

    def __init__(self, namespaces, extensions, enable_regexp,
                 smart_strings):
        self._context = _XPathContext(namespaces, extensions, self._error_log,
                                      enable_regexp, None, smart_strings)

    @property
    def error_log(self):
        assert self._error_log is not None, "XPath evaluator not initialised"
        return self._error_log.copy()

    def __dealloc__(self):
        if self._xpathCtxt is not NULL:
            xpath.xmlXPathFreeContext(self._xpathCtxt)
        if config.ENABLE_THREADING:
            if self._eval_lock is not NULL:
                python.PyThread_free_lock(self._eval_lock)

    cdef set_context(self, xpath.xmlXPathContext* xpathCtxt):
        self._xpathCtxt = xpathCtxt
        self._context.set_context(xpathCtxt)

    cdef bint _checkAbsolutePath(self, char* path) noexcept:
        cdef char c
        if path is NULL:
            return 0
        c = path[0]
        while c == c' ' or c == c'\t':
            path = path + 1
            c = path[0]
        return c == c'/'

    @cython.final
    cdef int _lock(self) except -1:
        cdef int result
        if config.ENABLE_THREADING and self._eval_lock != NULL:
            with nogil:
                result = python.PyThread_acquire_lock(
                    self._eval_lock, python.WAIT_LOCK)
            if result == 0:
                raise XPathError, "XPath evaluator locking failed"
        return 0

    @cython.final
    cdef void _unlock(self) noexcept:
        if config.ENABLE_THREADING and self._eval_lock != NULL:
            python.PyThread_release_lock(self._eval_lock)

    cdef _build_parse_error(self):
        cdef _BaseErrorLog entries
        entries = self._error_log.filter_types(_XPATH_SYNTAX_ERRORS)
        if entries:
            message = entries._buildExceptionMessage(None)
            if message is not None:
                return XPathSyntaxError(message, self._error_log)
        return XPathSyntaxError(
            self._error_log._buildExceptionMessage("Error in xpath expression"),
            self._error_log)

    cdef _build_eval_error(self):
        cdef _BaseErrorLog entries
        entries = self._error_log.filter_types(_XPATH_EVAL_ERRORS)
        if not entries:
            entries = self._error_log.filter_types(_XPATH_SYNTAX_ERRORS)
        if entries:
            message = entries._buildExceptionMessage(None)
            if message is not None:
                return XPathEvalError(message, self._error_log)
        return XPathEvalError(
            self._error_log._buildExceptionMessage("Error in xpath expression"),
            self._error_log)

    cdef object _handle_result(self, xpath.xmlXPathObject* xpathObj, _Document doc):
        if self._context._exc._has_raised():
            if xpathObj is not NULL:
                _freeXPathObject(xpathObj)
                xpathObj = NULL
            self._context._release_temp_refs()
            self._context._exc._raise_if_stored()

        if xpathObj is NULL:
            self._context._release_temp_refs()
            raise self._build_eval_error()

        try:
            result = _unwrapXPathObject(xpathObj, doc, self._context)
        finally:
            _freeXPathObject(xpathObj)
            self._context._release_temp_refs()

        return result


cdef class XPathElementEvaluator(_XPathEvaluatorBase):
    """XPathElementEvaluator(self, element, namespaces=None, extensions=None, regexp=True, smart_strings=True)
    Create an XPath evaluator for an element.

    Absolute XPath expressions (starting with '/') will be evaluated against
    the ElementTree as returned by getroottree().

    Additional namespace declarations can be passed with the
    'namespace' keyword argument.  EXSLT regular expression support
    can be disabled with the 'regexp' boolean keyword (defaults to
    True).  Smart strings will be returned for string results unless
    you pass ``smart_strings=False``.
    """
    cdef _Element _element
    def __init__(self, _Element element not None, *, namespaces=None,
                 extensions=None, regexp=True, smart_strings=True):
        cdef xpath.xmlXPathContext* xpathCtxt
        cdef int ns_register_status
        cdef _Document doc
        _assertValidNode(element)
        _assertValidDoc(element._doc)
        self._element = element
        doc = element._doc
        _XPathEvaluatorBase.__init__(self, namespaces, extensions,
                                     regexp, smart_strings)
        xpathCtxt = xpath.xmlXPathNewContext(doc._c_doc)
        if xpathCtxt is NULL:
            raise MemoryError()
        self.set_context(xpathCtxt)

    def register_namespace(self, prefix, uri):
        """Register a namespace with the XPath context.
        """
        assert self._xpathCtxt is not NULL, "XPath context not initialised"
        self._context.addNamespace(prefix, uri)

    def register_namespaces(self, namespaces):
        """Register a prefix -> uri dict.
        """
        assert self._xpathCtxt is not NULL, "XPath context not initialised"
        for prefix, uri in namespaces.items():
            self._context.addNamespace(prefix, uri)

    def __call__(self, _path, **_variables):
        """__call__(self, _path, **_variables)

        Evaluate an XPath expression on the document.

        Variables may be provided as keyword arguments.  Note that namespaces
        are currently not supported for variables.

        Absolute XPath expressions (starting with '/') will be evaluated
        against the ElementTree as returned by getroottree().
        """
        cdef xpath.xmlXPathObject*  xpathObj
        cdef _Document doc
        assert self._xpathCtxt is not NULL, "XPath context not initialised"
        path = _utf8(_path)
        doc = self._element._doc

        self._lock()
        self._xpathCtxt.node = self._element._c_node
        try:
            self._context.register_context(doc)
            self._context.registerVariables(_variables)
            c_path = _xcstr(path)
            with nogil:
                xpathObj = xpath.xmlXPathEvalExpression(
                    c_path, self._xpathCtxt)
            result = self._handle_result(xpathObj, doc)
        finally:
            self._context.unregister_context()
            self._unlock()

        return result


cdef class XPathDocumentEvaluator(XPathElementEvaluator):
    """XPathDocumentEvaluator(self, etree, namespaces=None, extensions=None, regexp=True, smart_strings=True)
    Create an XPath evaluator for an ElementTree.

    Additional namespace declarations can be passed with the
    'namespace' keyword argument.  EXSLT regular expression support
    can be disabled with the 'regexp' boolean keyword (defaults to
    True).  Smart strings will be returned for string results unless
    you pass ``smart_strings=False``.
    """
    def __init__(self, _ElementTree etree not None, *, namespaces=None,
                 extensions=None, regexp=True, smart_strings=True):
        XPathElementEvaluator.__init__(
            self, etree._context_node, namespaces=namespaces, 
            extensions=extensions, regexp=regexp,
            smart_strings=smart_strings)

    def __call__(self, _path, **_variables):
        """__call__(self, _path, **_variables)

        Evaluate an XPath expression on the document.

        Variables may be provided as keyword arguments.  Note that namespaces
        are currently not supported for variables.
        """
        cdef xpath.xmlXPathObject*  xpathObj
        cdef xmlDoc* c_doc
        cdef _Document doc
        assert self._xpathCtxt is not NULL, "XPath context not initialised"
        path = _utf8(_path)
        doc = self._element._doc

        self._lock()
        try:
            self._context.register_context(doc)
            c_doc = _fakeRootDoc(doc._c_doc, self._element._c_node)
            try:
                self._context.registerVariables(_variables)
                c_path = _xcstr(path)
                with nogil:
                    self._xpathCtxt.doc  = c_doc
                    self._xpathCtxt.node = tree.xmlDocGetRootElement(c_doc)
                    xpathObj = xpath.xmlXPathEvalExpression(
                        c_path, self._xpathCtxt)
                result = self._handle_result(xpathObj, doc)
            finally:
                _destroyFakeDoc(doc._c_doc, c_doc)
                self._context.unregister_context()
        finally:
            self._unlock()

        return result


def XPathEvaluator(etree_or_element, *, namespaces=None, extensions=None,
                   regexp=True, smart_strings=True):
    """XPathEvaluator(etree_or_element, namespaces=None, extensions=None, regexp=True, smart_strings=True)

    Creates an XPath evaluator for an ElementTree or an Element.

    The resulting object can be called with an XPath expression as argument
    and XPath variables provided as keyword arguments.

    Additional namespace declarations can be passed with the
    'namespace' keyword argument.  EXSLT regular expression support
    can be disabled with the 'regexp' boolean keyword (defaults to
    True).  Smart strings will be returned for string results unless
    you pass ``smart_strings=False``.
    """
    if isinstance(etree_or_element, _ElementTree):
        return XPathDocumentEvaluator(
            etree_or_element, namespaces=namespaces,
            extensions=extensions, regexp=regexp, smart_strings=smart_strings)
    else:
        return XPathElementEvaluator(
            etree_or_element, namespaces=namespaces,
            extensions=extensions, regexp=regexp, smart_strings=smart_strings)


cdef class XPath(_XPathEvaluatorBase):
    """XPath(self, path, namespaces=None, extensions=None, regexp=True, smart_strings=True)
    A compiled XPath expression that can be called on Elements and ElementTrees.

    Besides the XPath expression, you can pass prefix-namespace
    mappings and extension functions to the constructor through the
    keyword arguments ``namespaces`` and ``extensions``.  EXSLT
    regular expression support can be disabled with the 'regexp'
    boolean keyword (defaults to True).  Smart strings will be
    returned for string results unless you pass
    ``smart_strings=False``.
    """
    cdef xpath.xmlXPathCompExpr* _xpath
    cdef bytes _path
    def __cinit__(self):
        self._xpath = NULL

    def __init__(self, path, *, namespaces=None, extensions=None,
                 regexp=True, smart_strings=True):
        cdef xpath.xmlXPathContext* xpathCtxt
        _XPathEvaluatorBase.__init__(self, namespaces, extensions,
                                     regexp, smart_strings)
        self._path = _utf8(path)
        xpathCtxt = xpath.xmlXPathNewContext(NULL)
        if xpathCtxt is NULL:
            raise MemoryError()
        self.set_context(xpathCtxt)
        self._xpath = xpath.xmlXPathCtxtCompile(xpathCtxt, _xcstr(self._path))
        if self._xpath is NULL:
            raise self._build_parse_error()

    def __call__(self, _etree_or_element, **_variables):
        "__call__(self, _etree_or_element, **_variables)"
        cdef xpath.xmlXPathObject*  xpathObj
        cdef _Document document
        cdef _Element element

        assert self._xpathCtxt is not NULL, "XPath context not initialised"
        document = _documentOrRaise(_etree_or_element)
        element  = _rootNodeOrRaise(_etree_or_element)

        self._lock()
        self._xpathCtxt.doc  = document._c_doc
        self._xpathCtxt.node = element._c_node

        try:
            self._context.register_context(document)
            self._context.registerVariables(_variables)
            with nogil:
                xpathObj = xpath.xmlXPathCompiledEval(
                    self._xpath, self._xpathCtxt)
            result = self._handle_result(xpathObj, document)
        finally:
            self._context.unregister_context()
            self._unlock()
        return result

    @property
    def path(self):
        """The literal XPath expression.
        """
        return self._path.decode('UTF-8')

    def __dealloc__(self):
        if self._xpath is not NULL:
            xpath.xmlXPathFreeCompExpr(self._xpath)

    def __repr__(self):
        return self.path


cdef object _replace_strings = re.compile(b'("[^"]*")|(\'[^\']*\')').sub
cdef object _find_namespaces = re.compile(b'({[^}]+})').findall

cdef class ETXPath(XPath):
    """ETXPath(self, path, extensions=None, regexp=True, smart_strings=True)
    Special XPath class that supports the ElementTree {uri} notation for namespaces.

    Note that this class does not accept the ``namespace`` keyword
    argument. All namespaces must be passed as part of the path
    string.  Smart strings will be returned for string results unless
    you pass ``smart_strings=False``.
    """
    def __init__(self, path, *, extensions=None, regexp=True,
                 smart_strings=True):
        path, namespaces = self._nsextract_path(path)
        XPath.__init__(self, path, namespaces=namespaces,
                       extensions=extensions, regexp=regexp,
                       smart_strings=smart_strings)

    cdef _nsextract_path(self, path):
        # replace {namespaces} by new prefixes
        cdef dict namespaces = {}
        cdef list namespace_defs = []
        cdef int i
        path_utf = _utf8(path)
        stripped_path = _replace_strings(b'', path_utf) # remove string literals
        i = 1
        for namespace_def in _find_namespaces(stripped_path):
            if namespace_def not in namespace_defs:
                prefix = python.PyBytes_FromFormat("__xpp%02d", i)
                i += 1
                namespace_defs.append(namespace_def)
                namespace = namespace_def[1:-1] # remove '{}'
                namespace = (<bytes>namespace).decode('utf8')
                namespaces[prefix.decode('utf8')] = namespace
                prefix_str = prefix + b':'
                # FIXME: this also replaces {namespaces} within strings!
                path_utf = path_utf.replace(namespace_def, prefix_str)
        path = path_utf.decode('utf8')
        return path, namespaces
