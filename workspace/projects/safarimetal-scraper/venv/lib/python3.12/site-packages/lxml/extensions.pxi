# support for extension functions in XPath and XSLT

cdef class XPathError(LxmlError):
    """Base class of all XPath errors.
    """

cdef class XPathEvalError(XPathError):
    """Error during XPath evaluation.
    """

cdef class XPathFunctionError(XPathEvalError):
    """Internal error looking up an XPath extension function.
    """

cdef class XPathResultError(XPathEvalError):
    """Error handling an XPath result.
    """


# forward declarations

ctypedef int (*_register_function)(void* ctxt, name_utf, ns_uri_utf)
cdef class _ExsltRegExp

################################################################################
# Base class for XSLT and XPath evaluation contexts: functions, namespaces, ...

@cython.internal
cdef class _BaseContext:
    cdef xpath.xmlXPathContext* _xpathCtxt
    cdef _Document _doc
    cdef dict _extensions
    cdef list _namespaces
    cdef list _global_namespaces
    cdef dict _utf_refs
    cdef dict _function_cache
    cdef dict _eval_context_dict
    cdef bint _build_smart_strings
    # for exception handling and temporary reference keeping:
    cdef _TempStore _temp_refs
    cdef set _temp_documents
    cdef _ExceptionContext _exc
    cdef _ErrorLog _error_log

    def __init__(self, namespaces, extensions, error_log, enable_regexp,
                 build_smart_strings):
        cdef _ExsltRegExp _regexp
        cdef dict new_extensions
        cdef list ns
        self._utf_refs = {}
        self._global_namespaces = []
        self._function_cache = {}
        self._eval_context_dict = None
        self._error_log = error_log

        if extensions is not None:
            # convert extensions to UTF-8
            if isinstance(extensions, dict):
                extensions = (extensions,)
            # format: [ {(ns, name):function} ] -> {(ns_utf, name_utf):function}
            new_extensions = {}
            for extension in extensions:
                for (ns_uri, name), function in extension.items():
                    if name is None:
                        raise ValueError, "extensions must have non empty names"
                    ns_utf   = self._to_utf(ns_uri)
                    name_utf = self._to_utf(name)
                    new_extensions[(ns_utf, name_utf)] = function
            extensions = new_extensions or None

        if namespaces is not None:
            if isinstance(namespaces, dict):
                namespaces = namespaces.items()
            if namespaces:
                ns = []
                for prefix, ns_uri in namespaces:
                    if prefix is None or not prefix:
                        raise TypeError, \
                            "empty namespace prefix is not supported in XPath"
                    if ns_uri is None or not ns_uri:
                        raise TypeError, \
                            "setting default namespace is not supported in XPath"
                    prefix_utf = self._to_utf(prefix)
                    ns_uri_utf = self._to_utf(ns_uri)
                    ns.append( (prefix_utf, ns_uri_utf) )
                namespaces = ns
            else:
                namespaces = None

        self._doc        = None
        self._exc        = _ExceptionContext()
        self._extensions = extensions
        self._namespaces = namespaces
        self._temp_refs  = _TempStore()
        self._temp_documents  = set()
        self._build_smart_strings = build_smart_strings

        if enable_regexp:
            _regexp = _ExsltRegExp()
            _regexp._register_in_context(self)

    cdef _BaseContext _copy(self):
        cdef _BaseContext context
        if self._namespaces is not None:
            namespaces = self._namespaces[:]
        else:
            namespaces = None
        context = self.__class__(namespaces, None, self._error_log, False,
                                 self._build_smart_strings)
        if self._extensions is not None:
            context._extensions = self._extensions.copy()
        return context

    cdef bytes _to_utf(self, s):
        "Convert to UTF-8 and keep a reference to the encoded string"
        cdef python.PyObject* dict_result
        if s is None:
            return None
        dict_result = python.PyDict_GetItem(self._utf_refs, s)
        if dict_result is not NULL:
            return <bytes>dict_result
        utf = _utf8(s)
        self._utf_refs[s] = utf
        if python.IS_PYPY:
            # use C level refs, PyPy refs are not enough!
            python.Py_INCREF(utf)
        return utf

    cdef void _set_xpath_context(self, xpath.xmlXPathContext* xpathCtxt) noexcept:
        self._xpathCtxt = xpathCtxt
        xpathCtxt.userData = <void*>self
        # Need a cast here because older libxml2 releases do not use 'const' in the functype.
        xpathCtxt.error = <xmlerror.xmlStructuredErrorFunc> _receiveXPathError

    @cython.final
    cdef _register_context(self, _Document doc):
        self._doc = doc
        self._exc.clear()

    @cython.final
    cdef _cleanup_context(self):
        #xpath.xmlXPathRegisteredNsCleanup(self._xpathCtxt)
        #self.unregisterGlobalNamespaces()
        if python.IS_PYPY:
            # clean up double refs in PyPy (see "_to_utf()" method)
            for ref in self._utf_refs.itervalues():
                python.Py_DECREF(ref)
        self._utf_refs.clear()
        self._eval_context_dict = None
        self._doc = None

    @cython.final
    cdef _release_context(self):
        if self._xpathCtxt is not NULL:
            self._xpathCtxt.userData = NULL
            self._xpathCtxt = NULL

    # namespaces (internal UTF-8 methods with leading '_')

    cdef addNamespace(self, prefix, ns_uri):
        cdef list namespaces
        if prefix is None:
            raise TypeError, "empty prefix is not supported in XPath"
        prefix_utf = self._to_utf(prefix)
        ns_uri_utf = self._to_utf(ns_uri)
        new_item = (prefix_utf, ns_uri_utf)
        if self._namespaces is None:
            self._namespaces = [new_item]
        else:
            namespaces = []
            for item in self._namespaces:
                if item[0] == prefix_utf:
                    item = new_item
                    new_item = None
                namespaces.append(item)
            if new_item is not None:
                namespaces.append(new_item)
            self._namespaces = namespaces
        if self._xpathCtxt is not NULL:
            xpath.xmlXPathRegisterNs(
                self._xpathCtxt, _xcstr(prefix_utf), _xcstr(ns_uri_utf))

    cdef registerNamespace(self, prefix, ns_uri):
        if prefix is None:
            raise TypeError, "empty prefix is not supported in XPath"
        prefix_utf = self._to_utf(prefix)
        ns_uri_utf = self._to_utf(ns_uri)
        self._global_namespaces.append(prefix_utf)
        xpath.xmlXPathRegisterNs(self._xpathCtxt,
                                 _xcstr(prefix_utf), _xcstr(ns_uri_utf))

    cdef registerLocalNamespaces(self):
        if self._namespaces is None:
            return
        for prefix_utf, ns_uri_utf in self._namespaces:
            xpath.xmlXPathRegisterNs(
                self._xpathCtxt, _xcstr(prefix_utf), _xcstr(ns_uri_utf))

    cdef registerGlobalNamespaces(self):
        cdef list ns_prefixes = _find_all_extension_prefixes()
        if python.PyList_GET_SIZE(ns_prefixes) > 0:
            for prefix_utf, ns_uri_utf in ns_prefixes:
                self._global_namespaces.append(prefix_utf)
                xpath.xmlXPathRegisterNs(
                    self._xpathCtxt, _xcstr(prefix_utf), _xcstr(ns_uri_utf))

    cdef unregisterGlobalNamespaces(self):
        if python.PyList_GET_SIZE(self._global_namespaces) > 0:
            for prefix_utf in self._global_namespaces:
                xpath.xmlXPathRegisterNs(self._xpathCtxt,
                                         _xcstr(prefix_utf), NULL)
            del self._global_namespaces[:]

    cdef void _unregisterNamespace(self, prefix_utf) noexcept:
        xpath.xmlXPathRegisterNs(self._xpathCtxt,
                                 _xcstr(prefix_utf), NULL)

    # extension functions

    cdef int _addLocalExtensionFunction(self, ns_utf, name_utf, function) except -1:
        if self._extensions is None:
            self._extensions = {}
        self._extensions[(ns_utf, name_utf)] = function
        return 0

    cdef registerGlobalFunctions(self, void* ctxt,
                                 _register_function reg_func):
        cdef python.PyObject* dict_result
        cdef dict d
        for ns_utf, ns_functions in __FUNCTION_NAMESPACE_REGISTRIES.iteritems():
            dict_result = python.PyDict_GetItem(
                self._function_cache, ns_utf)
            if dict_result is not NULL:
                d = <dict>dict_result
            else:
                d = {}
                self._function_cache[ns_utf] = d
            for name_utf, function in ns_functions.iteritems():
                d[name_utf] = function
                reg_func(ctxt, name_utf, ns_utf)

    cdef registerLocalFunctions(self, void* ctxt,
                                _register_function reg_func):
        cdef python.PyObject* dict_result
        cdef dict d
        if self._extensions is None:
            return # done
        last_ns = None
        d = None
        for (ns_utf, name_utf), function in self._extensions.iteritems():
            if ns_utf is not last_ns or d is None:
                last_ns = ns_utf
                dict_result = python.PyDict_GetItem(
                    self._function_cache, ns_utf)
                if dict_result is not NULL:
                    d = <dict>dict_result
                else:
                    d = {}
                    self._function_cache[ns_utf] = d
            d[name_utf] = function
            reg_func(ctxt, name_utf, ns_utf)

    cdef unregisterAllFunctions(self, void* ctxt,
                                      _register_function unreg_func):
        for ns_utf, functions in self._function_cache.iteritems():
            for name_utf in functions:
                unreg_func(ctxt, name_utf, ns_utf)

    cdef unregisterGlobalFunctions(self, void* ctxt,
                                         _register_function unreg_func):
        for ns_utf, functions in self._function_cache.items():
            for name_utf in functions:
                if self._extensions is None or \
                       (ns_utf, name_utf) not in self._extensions:
                    unreg_func(ctxt, name_utf, ns_utf)

    @cython.final
    cdef _find_cached_function(self, const_xmlChar* c_ns_uri, const_xmlChar* c_name):
        """Lookup an extension function in the cache and return it.

        Parameters: c_ns_uri may be NULL, c_name must not be NULL
        """
        cdef python.PyObject* c_dict
        cdef python.PyObject* dict_result
        c_dict = python.PyDict_GetItem(
            self._function_cache, None if c_ns_uri is NULL else c_ns_uri)
        if c_dict is not NULL:
            dict_result = python.PyDict_GetItem(
                <object>c_dict, <unsigned char*>c_name)
            if dict_result is not NULL:
                return <object>dict_result
        return None

    # Python access to the XPath context for extension functions

    @property
    def context_node(self):
        cdef xmlNode* c_node
        if self._xpathCtxt is NULL:
            raise XPathError, \
                "XPath context is only usable during the evaluation"
        c_node = self._xpathCtxt.node
        if c_node is NULL:
            raise XPathError, "no context node"
        if c_node.doc != self._xpathCtxt.doc:
            raise XPathError, \
                "document-external context nodes are not supported"
        if self._doc is None:
            raise XPathError, "document context is missing"
        return _elementFactory(self._doc, c_node)

    @property
    def eval_context(self):
        if self._eval_context_dict is None:
            self._eval_context_dict = {}
        return self._eval_context_dict

    # Python reference keeping during XPath function evaluation

    @cython.final
    cdef _release_temp_refs(self):
        "Free temporarily referenced objects from this context."
        self._temp_refs.clear()
        self._temp_documents.clear()

    @cython.final
    cdef _hold(self, obj):
        """A way to temporarily hold references to nodes in the evaluator.

        This is needed because otherwise nodes created in XPath extension
        functions would be reference counted too soon, during the XPath
        evaluation.  This is most important in the case of exceptions.
        """
        cdef _Element element
        if isinstance(obj, _Element):
            self._temp_refs.add(obj)
            self._temp_documents.add((<_Element>obj)._doc)
            return
        elif _isString(obj) or not python.PySequence_Check(obj):
            return
        for o in obj:
            if isinstance(o, _Element):
                #print "Holding element:", <int>element._c_node
                self._temp_refs.add(o)
                #print "Holding document:", <int>element._doc._c_doc
                self._temp_documents.add((<_Element>o)._doc)

    @cython.final
    cdef _Document _findDocumentForNode(self, xmlNode* c_node):
        """If an XPath expression returns an element from a different
        document than the current context document, we call this to
        see if it was possibly created by an extension and is a known
        document instance.
        """
        cdef _Document doc
        for doc in self._temp_documents:
            if doc is not None and doc._c_doc is c_node.doc:
                return doc
        return None


# libxml2 keeps these error messages in a static array in its code
# and doesn't give us access to them ...

cdef tuple LIBXML2_XPATH_ERROR_MESSAGES = (
    b"Ok",
    b"Number encoding",
    b"Unfinished literal",
    b"Start of literal",
    b"Expected $ for variable reference",
    b"Undefined variable",
    b"Invalid predicate",
    b"Invalid expression",
    b"Missing closing curly brace",
    b"Unregistered function",
    b"Invalid operand",
    b"Invalid type",
    b"Invalid number of arguments",
    b"Invalid context size",
    b"Invalid context position",
    b"Memory allocation error",
    b"Syntax error",
    b"Resource error",
    b"Sub resource error",
    b"Undefined namespace prefix",
    b"Encoding error",
    b"Char out of XML range",
    b"Invalid or incomplete context",
    b"Stack usage error",
    b"Forbidden variable\n",
    b"?? Unknown error ??\n",
)

cdef void _forwardXPathError(void* c_ctxt, const xmlerror.xmlError* c_error) noexcept with gil:
    cdef xmlerror.xmlError error
    cdef int xpath_code
    if c_error.message is not NULL:
        error.message = c_error.message
    else:
        xpath_code = c_error.code - xmlerror.XML_XPATH_EXPRESSION_OK
        if 0 <= xpath_code < len(LIBXML2_XPATH_ERROR_MESSAGES):
            error.message = _cstr(LIBXML2_XPATH_ERROR_MESSAGES[xpath_code])
        else:
            error.message = b"unknown error"
    error.domain = c_error.domain
    error.code = c_error.code
    error.level = c_error.level
    error.line = c_error.line
    error.int2 = c_error.int1 # column
    error.file = c_error.file
    error.node = NULL

    (<_BaseContext>c_ctxt)._error_log._receive(&error)

cdef void _receiveXPathError(void* c_context, const xmlerror.xmlError* error) noexcept nogil:
    if not __DEBUG:
        return
    if c_context is NULL:
        _forwardError(NULL, error)
    else:
        _forwardXPathError(c_context, error)


def Extension(module, function_mapping=None, *, ns=None):
    """Extension(module, function_mapping=None, ns=None)

    Build a dictionary of extension functions from the functions
    defined in a module or the methods of an object.

    As second argument, you can pass an additional mapping of
    attribute names to XPath function names, or a list of function
    names that should be taken.

    The ``ns`` keyword argument accepts a namespace URI for the XPath
    functions.
    """
    cdef dict functions = {}
    if isinstance(function_mapping, dict):
        for function_name, xpath_name in function_mapping.items():
            functions[(ns, xpath_name)] = getattr(module, function_name)
    else:
        if function_mapping is None:
            function_mapping = [ name for name in dir(module)
                                 if not name.startswith('_') ]
        for function_name in function_mapping:
            functions[(ns, function_name)] = getattr(module, function_name)
    return functions

################################################################################
# EXSLT regexp implementation

@cython.final
@cython.internal
cdef class _ExsltRegExp:
    cdef dict _compile_map
    def __cinit__(self):
        self._compile_map = {}

    cdef _make_string(self, value):
        if _isString(value):
            return value
        elif isinstance(value, list):
            # node set: take recursive text concatenation of first element
            if python.PyList_GET_SIZE(value) == 0:
                return ''
            firstnode = value[0]
            if _isString(firstnode):
                return firstnode
            elif isinstance(firstnode, _Element):
                c_text = tree.xmlNodeGetContent((<_Element>firstnode)._c_node)
                if c_text is NULL:
                    raise MemoryError()
                try:
                    return funicode(c_text)
                finally:
                    tree.xmlFree(c_text)
            else:
                return unicode(firstnode)
        else:
            return unicode(value)

    cdef _compile(self, rexp, ignore_case):
        cdef python.PyObject* c_result
        rexp = self._make_string(rexp)
        key = (rexp, ignore_case)
        c_result = python.PyDict_GetItem(self._compile_map, key)
        if c_result is not NULL:
            return <object>c_result
        py_flags = re.UNICODE
        if ignore_case:
            py_flags = py_flags | re.IGNORECASE
        rexp_compiled = re.compile(rexp, py_flags)
        self._compile_map[key] = rexp_compiled
        return rexp_compiled

    def test(self, ctxt, s, rexp, flags=''):
        flags = self._make_string(flags)
        s = self._make_string(s)
        rexpc = self._compile(rexp, 'i' in flags)
        if rexpc.search(s) is None:
            return False
        else:
            return True

    def match(self, ctxt, s, rexp, flags=''):
        cdef list result_list
        flags = self._make_string(flags)
        s = self._make_string(s)
        rexpc = self._compile(rexp, 'i' in flags)
        if 'g' in flags:
            results = rexpc.findall(s)
            if not results:
                return ()
        else:
            result = rexpc.search(s)
            if not result:
                return ()
            results = [ result.group() ]
            results.extend( result.groups('') )
        result_list = []
        root = Element('matches')
        for s_match in results:
            if python.PyTuple_CheckExact(s_match):
                s_match = ''.join(s_match)
            elem = SubElement(root, 'match')
            elem.text = s_match
            result_list.append(elem)
        return result_list

    def replace(self, ctxt, s, rexp, flags, replacement):
        replacement = self._make_string(replacement)
        flags = self._make_string(flags)
        s = self._make_string(s)
        rexpc = self._compile(rexp, 'i' in flags)
        count: object = 0 if 'g' in flags else 1
        return rexpc.sub(replacement, s, count)

    cdef _register_in_context(self, _BaseContext context):
        ns = b"http://exslt.org/regular-expressions"
        context._addLocalExtensionFunction(ns, b"test",    self.test)
        context._addLocalExtensionFunction(ns, b"match",   self.match)
        context._addLocalExtensionFunction(ns, b"replace", self.replace)


################################################################################
# helper functions

cdef xpath.xmlXPathObject* _wrapXPathObject(object obj, _Document doc,
                                            _BaseContext context) except NULL:
    cdef xpath.xmlNodeSet* resultSet
    cdef _Element fake_node = None
    cdef xmlNode* c_node

    if isinstance(obj, unicode):
        obj = _utf8(obj)
    if isinstance(obj, bytes):
        # libxml2 copies the string value
        return xpath.xmlXPathNewCString(_cstr(obj))
    if isinstance(obj, bool):
        return xpath.xmlXPathNewBoolean(obj)
    if python.PyNumber_Check(obj):
        return xpath.xmlXPathNewFloat(obj)
    if obj is None:
        resultSet = xpath.xmlXPathNodeSetCreate(NULL)
    elif isinstance(obj, _Element):
        resultSet = xpath.xmlXPathNodeSetCreate((<_Element>obj)._c_node)
    elif python.PySequence_Check(obj):
        resultSet = xpath.xmlXPathNodeSetCreate(NULL)
        try:
            for value in obj:
                if isinstance(value, _Element):
                    if context is not None:
                        context._hold(value)
                    xpath.xmlXPathNodeSetAdd(resultSet, (<_Element>value)._c_node)
                else:
                    if context is None or doc is None:
                        raise XPathResultError, \
                              f"Non-Element values not supported at this point - got {value!r}"
                    # support strings by appending text nodes to an Element
                    if isinstance(value, unicode):
                        value = _utf8(value)
                    if isinstance(value, bytes):
                        if fake_node is None:
                            fake_node = _makeElement("text-root", NULL, doc, None,
                                                     None, None, None, None, None)
                            context._hold(fake_node)
                        else:
                            # append a comment node to keep the text nodes separate
                            c_node = tree.xmlNewDocComment(doc._c_doc, <unsigned char*>"")
                            if c_node is NULL:
                                raise MemoryError()
                            tree.xmlAddChild(fake_node._c_node, c_node)
                        context._hold(value)
                        c_node = tree.xmlNewDocText(doc._c_doc, _xcstr(value))
                        if c_node is NULL:
                            raise MemoryError()
                        tree.xmlAddChild(fake_node._c_node, c_node)
                        xpath.xmlXPathNodeSetAdd(resultSet, c_node)
                    else:
                        raise XPathResultError, \
                              f"This is not a supported node-set result: {value!r}"
        except:
            xpath.xmlXPathFreeNodeSet(resultSet)
            raise
    else:
        raise XPathResultError, f"Unknown return type: {python._fqtypename(obj).decode('utf8')}"
    return xpath.xmlXPathWrapNodeSet(resultSet)

cdef object _unwrapXPathObject(xpath.xmlXPathObject* xpathObj,
                               _Document doc, _BaseContext context):
    if xpathObj.type == xpath.XPATH_UNDEFINED:
        raise XPathResultError, "Undefined xpath result"
    elif xpathObj.type == xpath.XPATH_NODESET:
        return _createNodeSetResult(xpathObj, doc, context)
    elif xpathObj.type == xpath.XPATH_BOOLEAN:
        return xpathObj.boolval
    elif xpathObj.type == xpath.XPATH_NUMBER:
        return xpathObj.floatval
    elif xpathObj.type == xpath.XPATH_STRING:
        stringval = funicode(xpathObj.stringval)
        if context._build_smart_strings:
            stringval = _elementStringResultFactory(
                stringval, None, None, False)
        return stringval
    elif xpathObj.type == xpath.XPATH_POINT:
        raise NotImplementedError, "XPATH_POINT"
    elif xpathObj.type == xpath.XPATH_RANGE:
        raise NotImplementedError, "XPATH_RANGE"
    elif xpathObj.type == xpath.XPATH_LOCATIONSET:
        raise NotImplementedError, "XPATH_LOCATIONSET"
    elif xpathObj.type == xpath.XPATH_USERS:
        raise NotImplementedError, "XPATH_USERS"
    elif xpathObj.type == xpath.XPATH_XSLT_TREE:
        return _createNodeSetResult(xpathObj, doc, context)
    else:
        raise XPathResultError, f"Unknown xpath result {xpathObj.type}"

cdef object _createNodeSetResult(xpath.xmlXPathObject* xpathObj, _Document doc,
                                 _BaseContext context):
    cdef xmlNode* c_node
    cdef int i
    cdef list result
    result = []
    if xpathObj.nodesetval is NULL:
        return result
    for i in range(xpathObj.nodesetval.nodeNr):
        c_node = xpathObj.nodesetval.nodeTab[i]
        _unpackNodeSetEntry(result, c_node, doc, context,
                            xpathObj.type == xpath.XPATH_XSLT_TREE)
    return result

cdef _unpackNodeSetEntry(list results, xmlNode* c_node, _Document doc,
                         _BaseContext context, bint is_fragment):
    cdef xmlNode* c_child
    if _isElement(c_node):
        if c_node.doc != doc._c_doc and c_node.doc._private is NULL:
            # XXX: works, but maybe not always the right thing to do?
            # XPath: only runs when extensions create or copy trees
            #        -> we store Python refs to these, so that is OK
            # XSLT: can it leak when merging trees from multiple sources?
            c_node = tree.xmlDocCopyNode(c_node, doc._c_doc, 1)
            # FIXME: call _instantiateElementFromXPath() instead?
        results.append(
            _fakeDocElementFactory(doc, c_node))
    elif c_node.type == tree.XML_TEXT_NODE or \
             c_node.type == tree.XML_CDATA_SECTION_NODE or \
             c_node.type == tree.XML_ATTRIBUTE_NODE:
        results.append(
            _buildElementStringResult(doc, c_node, context))
    elif c_node.type == tree.XML_NAMESPACE_DECL:
        results.append( (funicodeOrNone((<xmlNs*>c_node).prefix),
                         funicodeOrNone((<xmlNs*>c_node).href)) )
    elif c_node.type == tree.XML_DOCUMENT_NODE or \
            c_node.type == tree.XML_HTML_DOCUMENT_NODE:
        # ignored for everything but result tree fragments
        if is_fragment:
            c_child = c_node.children
            while c_child is not NULL:
                _unpackNodeSetEntry(results, c_child, doc, context, 0)
                c_child = c_child.next
    elif c_node.type == tree.XML_XINCLUDE_START or \
            c_node.type == tree.XML_XINCLUDE_END:
        pass
    else:
        raise NotImplementedError, \
            f"Not yet implemented result node type: {c_node.type}"

cdef void _freeXPathObject(xpath.xmlXPathObject* xpathObj) noexcept:
    """Free the XPath object, but *never* free the *content* of node sets.
    Python dealloc will do that for us.
    """
    if xpathObj.nodesetval is not NULL:
        xpath.xmlXPathFreeNodeSet(xpathObj.nodesetval)
        xpathObj.nodesetval = NULL
    xpath.xmlXPathFreeObject(xpathObj)

cdef _Element _instantiateElementFromXPath(xmlNode* c_node, _Document doc,
                                           _BaseContext context):
    # NOTE: this may copy the element - only call this when it can't leak
    if c_node.doc != doc._c_doc and c_node.doc._private is NULL:
        # not from the context document and not from a fake document
        # either => may still be from a known document, e.g. one
        # created by an extension function
        node_doc = context._findDocumentForNode(c_node)
        if node_doc is None:
            # not from a known document at all! => can only make a
            # safety copy here
            c_node = tree.xmlDocCopyNode(c_node, doc._c_doc, 1)
        else:
            doc = node_doc
    return _fakeDocElementFactory(doc, c_node)

################################################################################
# special str/unicode subclasses

@cython.final
cdef class _ElementUnicodeResult(unicode):
    cdef _Element _parent
    cdef readonly object attrname
    cdef readonly bint is_tail

    def getparent(self):
        return self._parent

    @property
    def is_text(self):
        return self._parent is not None and not (self.is_tail or self.attrname is not None)

    @property
    def is_attribute(self):
        return self.attrname is not None

cdef object _elementStringResultFactory(string_value, _Element parent,
                                        attrname, bint is_tail):
    result = _ElementUnicodeResult(string_value)
    result._parent = parent
    result.is_tail = is_tail
    result.attrname = attrname
    return result

cdef object _buildElementStringResult(_Document doc, xmlNode* c_node,
                                      _BaseContext context):
    cdef _Element parent = None
    cdef object attrname = None
    cdef xmlNode* c_element
    cdef bint is_tail

    if c_node.type == tree.XML_ATTRIBUTE_NODE:
        attrname = _namespacedName(c_node)
        is_tail = 0
        s = tree.xmlNodeGetContent(c_node)
        try:
            value = funicode(s)
        finally:
            tree.xmlFree(s)
        c_element = NULL
    else:
        #assert c_node.type == tree.XML_TEXT_NODE or c_node.type == tree.XML_CDATA_SECTION_NODE, "invalid node type"
        # may be tail text or normal text
        value = funicode(c_node.content)
        c_element = _previousElement(c_node)
        is_tail = c_element is not NULL

    if not context._build_smart_strings:
        return value

    if c_element is NULL:
        # non-tail text or attribute text
        c_element = c_node.parent
        while c_element is not NULL and not _isElement(c_element):
            c_element = c_element.parent

    if c_element is not NULL:
        parent = _instantiateElementFromXPath(c_element, doc, context)

    return _elementStringResultFactory(
        value, parent, attrname, is_tail)

################################################################################
# callbacks for XPath/XSLT extension functions

cdef void _extension_function_call(_BaseContext context, function,
                                   xpath.xmlXPathParserContext* ctxt, int nargs) noexcept:
    cdef _Document doc
    cdef xpath.xmlXPathObject* obj
    cdef list args
    cdef int i
    doc = context._doc
    try:
        args = []
        for i in range(nargs):
            obj = xpath.valuePop(ctxt)
            o = _unwrapXPathObject(obj, doc, context)
            _freeXPathObject(obj)
            args.append(o)
        args.reverse()

        res = function(context, *args)
        # wrap result for XPath consumption
        obj = _wrapXPathObject(res, doc, context)
        # prevent Python from deallocating elements handed to libxml2
        context._hold(res)
        xpath.valuePush(ctxt, obj)
    except:
        xpath.xmlXPathErr(ctxt, xpath.XPATH_EXPR_ERROR)
        context._exc._store_raised()
    finally:
        return  # swallow any further exceptions

# lookup the function by name and call it

cdef void _xpath_function_call(xpath.xmlXPathParserContext* ctxt,
                               int nargs) noexcept with gil:
    cdef _BaseContext context
    cdef xpath.xmlXPathContext* rctxt = ctxt.context
    context = <_BaseContext> rctxt.userData
    try:
        function = context._find_cached_function(rctxt.functionURI, rctxt.function)
        if function is not None:
            _extension_function_call(context, function, ctxt, nargs)
        else:
            xpath.xmlXPathErr(ctxt, xpath.XPATH_UNKNOWN_FUNC_ERROR)
            context._exc._store_exception(XPathFunctionError(
                f"XPath function '{_namespacedNameFromNsName(rctxt.functionURI, rctxt.function)}' not found"))
    except:
        # may not be the right error, but we need to tell libxml2 *something*
        xpath.xmlXPathErr(ctxt, xpath.XPATH_UNKNOWN_FUNC_ERROR)
        context._exc._store_raised()
    finally:
        return  # swallow any further exceptions
