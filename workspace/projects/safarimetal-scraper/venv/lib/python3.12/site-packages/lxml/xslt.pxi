# XSLT
from lxml.includes cimport xslt


cdef class XSLTError(LxmlError):
    """Base class of all XSLT errors.
    """

cdef class XSLTParseError(XSLTError):
    """Error parsing a stylesheet document.
    """

cdef class XSLTApplyError(XSLTError):
    """Error running an XSL transformation.
    """

class XSLTSaveError(XSLTError, SerialisationError):
    """Error serialising an XSLT result.
    """

cdef class XSLTExtensionError(XSLTError):
    """Error registering an XSLT extension.
    """


# version information
LIBXSLT_COMPILED_VERSION = __unpackIntVersion(xslt.LIBXSLT_VERSION)
LIBXSLT_VERSION = __unpackIntVersion(xslt.xsltLibxsltVersion)


################################################################################
# Where do we store what?
#
# xsltStylesheet->doc->_private
#    == _XSLTResolverContext for XSL stylesheet
#
# xsltTransformContext->_private
#    == _XSLTResolverContext for transformed document
#
################################################################################


################################################################################
# XSLT document loaders

@cython.final
@cython.internal
cdef class _XSLTResolverContext(_ResolverContext):
    cdef xmlDoc* _c_style_doc
    cdef _BaseParser _parser

    cdef _XSLTResolverContext _copy(self):
        cdef _XSLTResolverContext context
        context = _XSLTResolverContext()
        _initXSLTResolverContext(context, self._parser)
        context._c_style_doc = self._c_style_doc
        return context

cdef _initXSLTResolverContext(_XSLTResolverContext context,
                              _BaseParser parser):
    _initResolverContext(context, parser.resolvers)
    context._parser = parser
    context._c_style_doc = NULL

cdef xmlDoc* _xslt_resolve_from_python(const_xmlChar* c_uri, void* c_context,
                                       int parse_options, int* error) with gil:
    # call the Python document loaders
    cdef _XSLTResolverContext context
    cdef _ResolverRegistry resolvers
    cdef _InputDocument doc_ref
    cdef xmlDoc* c_doc
    cdef xmlDoc* c_return_doc = NULL

    error[0] = 0
    context = <_XSLTResolverContext>c_context

    # shortcut if we resolve the stylesheet itself
    c_doc = context._c_style_doc
    try:
        if c_doc is not NULL and c_doc.URL is not NULL:
            if tree.xmlStrcmp(c_uri, c_doc.URL) == 0:
                c_return_doc = _copyDoc(c_doc, 1)
                return c_return_doc  # 'goto', see 'finally' below

        # delegate to the Python resolvers
        resolvers = context._resolvers
        if tree.xmlStrncmp(<unsigned char*>'string://__STRING__XSLT__/', c_uri, 26) == 0:
            c_uri += 26
        uri = _decodeFilename(c_uri)
        doc_ref = resolvers.resolve(uri, None, context)

        if doc_ref is not None:
            if doc_ref._type == PARSER_DATA_STRING:
                c_return_doc = _parseDoc(
                    doc_ref._data_bytes, doc_ref._filename, context._parser)
            elif doc_ref._type == PARSER_DATA_FILENAME:
                c_return_doc = _parseDocFromFile(
                    doc_ref._filename, context._parser)
            elif doc_ref._type == PARSER_DATA_FILE:
                c_return_doc = _parseDocFromFilelike(
                    doc_ref._file, doc_ref._filename, context._parser)
            elif doc_ref._type == PARSER_DATA_EMPTY:
                c_return_doc = _newXMLDoc()
            if c_return_doc is not NULL and c_return_doc.URL is NULL:
                c_return_doc.URL = tree.xmlStrdup(c_uri)
    except:
        error[0] = 1
        context._store_raised()
    finally:
        return c_return_doc  # and swallow any further exceptions


cdef void _xslt_store_resolver_exception(const_xmlChar* c_uri, void* context,
                                         xslt.xsltLoadType c_type) noexcept with gil:
    try:
        message = f"Cannot resolve URI {_decodeFilename(c_uri)}"
        if c_type == xslt.XSLT_LOAD_DOCUMENT:
            exception = XSLTApplyError(message)
        else:
            exception = XSLTParseError(message)
        (<_XSLTResolverContext>context)._store_exception(exception)
    except BaseException as e:
        (<_XSLTResolverContext>context)._store_exception(e)
    finally:
        return  # and swallow any further exceptions


cdef xmlDoc* _xslt_doc_loader(const_xmlChar* c_uri, tree.xmlDict* c_dict,
                              int parse_options, void* c_ctxt,
                              xslt.xsltLoadType c_type) noexcept nogil:
    # nogil => no Python objects here, may be called without thread context !
    cdef xmlDoc* c_doc
    cdef xmlDoc* result
    cdef void* c_pcontext
    cdef int error = 0
    # find resolver contexts of stylesheet and transformed doc
    if c_type == xslt.XSLT_LOAD_DOCUMENT:
        # transformation time
        c_pcontext = (<xslt.xsltTransformContext*>c_ctxt)._private
    elif c_type == xslt.XSLT_LOAD_STYLESHEET:
        # include/import resolution while parsing
        c_pcontext = (<xslt.xsltStylesheet*>c_ctxt).doc._private
    else:
        c_pcontext = NULL

    if c_pcontext is NULL:
        # can't call Python without context, fall back to default loader
        return XSLT_DOC_DEFAULT_LOADER(
            c_uri, c_dict, parse_options, c_ctxt, c_type)

    c_doc = _xslt_resolve_from_python(c_uri, c_pcontext, parse_options, &error)
    if c_doc is NULL and not error:
        c_doc = XSLT_DOC_DEFAULT_LOADER(
            c_uri, c_dict, parse_options, c_ctxt, c_type)
        if c_doc is NULL:
            _xslt_store_resolver_exception(c_uri, c_pcontext, c_type)

    if c_doc is not NULL and c_type == xslt.XSLT_LOAD_STYLESHEET:
        c_doc._private = c_pcontext
    return c_doc

cdef xslt.xsltDocLoaderFunc XSLT_DOC_DEFAULT_LOADER = xslt.xsltDocDefaultLoader
xslt.xsltSetLoaderFunc(<xslt.xsltDocLoaderFunc>_xslt_doc_loader)

################################################################################
# XSLT file/network access control

cdef class XSLTAccessControl:
    """XSLTAccessControl(self, read_file=True, write_file=True, create_dir=True, read_network=True, write_network=True)

    Access control for XSLT: reading/writing files, directories and
    network I/O.  Access to a type of resource is granted or denied by
    passing any of the following boolean keyword arguments.  All of
    them default to True to allow access.

    - read_file
    - write_file
    - create_dir
    - read_network
    - write_network

    For convenience, there is also a class member `DENY_ALL` that
    provides an XSLTAccessControl instance that is readily configured
    to deny everything, and a `DENY_WRITE` member that denies all
    write access but allows read access.

    See `XSLT`.
    """
    cdef xslt.xsltSecurityPrefs* _prefs
    def __cinit__(self):
        self._prefs = xslt.xsltNewSecurityPrefs()
        if self._prefs is NULL:
            raise MemoryError()

    def __init__(self, *, bint read_file=True, bint write_file=True, bint create_dir=True,
                 bint read_network=True, bint write_network=True):
        self._setAccess(xslt.XSLT_SECPREF_READ_FILE, read_file)
        self._setAccess(xslt.XSLT_SECPREF_WRITE_FILE, write_file)
        self._setAccess(xslt.XSLT_SECPREF_CREATE_DIRECTORY, create_dir)
        self._setAccess(xslt.XSLT_SECPREF_READ_NETWORK, read_network)
        self._setAccess(xslt.XSLT_SECPREF_WRITE_NETWORK, write_network)

    DENY_ALL = XSLTAccessControl(
        read_file=False, write_file=False, create_dir=False,
        read_network=False, write_network=False)

    DENY_WRITE = XSLTAccessControl(
        read_file=True, write_file=False, create_dir=False,
        read_network=True, write_network=False)

    def __dealloc__(self):
        if self._prefs is not NULL:
            xslt.xsltFreeSecurityPrefs(self._prefs)

    @cython.final
    cdef _setAccess(self, xslt.xsltSecurityOption option, bint allow):
        cdef xslt.xsltSecurityCheck function
        if allow:
            function = xslt.xsltSecurityAllow
        else:
            function = xslt.xsltSecurityForbid
        xslt.xsltSetSecurityPrefs(self._prefs, option, function)

    @cython.final
    cdef void _register_in_context(self, xslt.xsltTransformContext* ctxt) noexcept:
        xslt.xsltSetCtxtSecurityPrefs(self._prefs, ctxt)

    @property
    def options(self):
        """The access control configuration as a map of options."""
        return {
            'read_file': self._optval(xslt.XSLT_SECPREF_READ_FILE),
            'write_file': self._optval(xslt.XSLT_SECPREF_WRITE_FILE),
            'create_dir': self._optval(xslt.XSLT_SECPREF_CREATE_DIRECTORY),
            'read_network': self._optval(xslt.XSLT_SECPREF_READ_NETWORK),
            'write_network': self._optval(xslt.XSLT_SECPREF_WRITE_NETWORK),
        }

    @cython.final
    cdef _optval(self, xslt.xsltSecurityOption option):
        cdef xslt.xsltSecurityCheck function
        function = xslt.xsltGetSecurityPrefs(self._prefs, option)
        if function is <xslt.xsltSecurityCheck>xslt.xsltSecurityAllow:
            return True
        elif function is <xslt.xsltSecurityCheck>xslt.xsltSecurityForbid:
            return False
        else:
            return None

    def __repr__(self):
        items = sorted(self.options.items())
        return "%s(%s)" % (
            python._fqtypename(self).decode('UTF-8').split('.')[-1],
            ', '.join(["%s=%r" % item for item in items]))

################################################################################
# XSLT

cdef int _register_xslt_function(void* ctxt, name_utf, ns_utf) noexcept:
    if ns_utf is None:
        return 0
    # libxml2 internalises the strings if ctxt has a dict
    return xslt.xsltRegisterExtFunction(
        <xslt.xsltTransformContext*>ctxt, _xcstr(name_utf), _xcstr(ns_utf),
        <xslt.xmlXPathFunction>_xpath_function_call)

cdef dict EMPTY_DICT = {}

@cython.final
@cython.internal
cdef class _XSLTContext(_BaseContext):
    cdef xslt.xsltTransformContext* _xsltCtxt
    cdef _ReadOnlyElementProxy _extension_element_proxy
    cdef dict _extension_elements
    def __cinit__(self):
        self._xsltCtxt = NULL
        self._extension_elements = EMPTY_DICT

    def __init__(self, namespaces, extensions, error_log, enable_regexp,
                 build_smart_strings):
        if extensions is not None and extensions:
            for ns_name_tuple, extension in extensions.items():
                if ns_name_tuple[0] is None:
                    raise XSLTExtensionError, \
                        "extensions must not have empty namespaces"
                if isinstance(extension, XSLTExtension):
                    if self._extension_elements is EMPTY_DICT:
                        self._extension_elements = {}
                        extensions = extensions.copy()
                    ns_utf   = _utf8(ns_name_tuple[0])
                    name_utf = _utf8(ns_name_tuple[1])
                    self._extension_elements[(ns_utf, name_utf)] = extension
                    del extensions[ns_name_tuple]
        _BaseContext.__init__(self, namespaces, extensions, error_log, enable_regexp,
                              build_smart_strings)

    cdef _BaseContext _copy(self):
        cdef _XSLTContext context
        context = <_XSLTContext>_BaseContext._copy(self)
        context._extension_elements = self._extension_elements
        return context

    cdef register_context(self, xslt.xsltTransformContext* xsltCtxt,
                               _Document doc):
        self._xsltCtxt = xsltCtxt
        self._set_xpath_context(xsltCtxt.xpathCtxt)
        self._register_context(doc)
        self.registerLocalFunctions(xsltCtxt, _register_xslt_function)
        self.registerGlobalFunctions(xsltCtxt, _register_xslt_function)
        _registerXSLTExtensions(xsltCtxt, self._extension_elements)

    cdef free_context(self):
        self._cleanup_context()
        self._release_context()
        if self._xsltCtxt is not NULL:
            xslt.xsltFreeTransformContext(self._xsltCtxt)
            self._xsltCtxt = NULL
        self._release_temp_refs()


@cython.final
@cython.internal
@cython.freelist(8)
cdef class _XSLTQuotedStringParam:
    """A wrapper class for literal XSLT string parameters that require
    quote escaping.
    """
    cdef bytes strval
    def __cinit__(self, strval):
        self.strval = _utf8(strval)


@cython.no_gc_clear
cdef class XSLT:
    """XSLT(self, xslt_input, extensions=None, regexp=True, access_control=None)

    Turn an XSL document into an XSLT object.

    Calling this object on a tree or Element will execute the XSLT::

        transform = etree.XSLT(xsl_tree)
        result = transform(xml_tree)

    Keyword arguments of the constructor:

    - extensions: a dict mapping ``(namespace, name)`` pairs to
      extension functions or extension elements
    - regexp: enable exslt regular expression support in XPath
      (default: True)
    - access_control: access restrictions for network or file
      system (see `XSLTAccessControl`)

    Keyword arguments of the XSLT call:

    - profile_run: enable XSLT profiling and make the profile available
      as XML document in ``result.xslt_profile`` (default: False)

    Other keyword arguments of the call are passed to the stylesheet
    as parameters.
    """
    cdef _XSLTContext _context
    cdef xslt.xsltStylesheet* _c_style
    cdef _XSLTResolverContext _xslt_resolver_context
    cdef XSLTAccessControl _access_control
    cdef _ErrorLog _error_log

    def __cinit__(self):
        self._c_style = NULL

    def __init__(self, xslt_input, *, extensions=None, regexp=True,
                 access_control=None):
        cdef xslt.xsltStylesheet* c_style = NULL
        cdef xmlDoc* c_doc
        cdef _Document doc
        cdef _Element root_node

        doc = _documentOrRaise(xslt_input)
        root_node = _rootNodeOrRaise(xslt_input)

        # set access control or raise TypeError
        self._access_control = access_control

        # make a copy of the document as stylesheet parsing modifies it
        c_doc = _copyDocRoot(doc._c_doc, root_node._c_node)

        # make sure we always have a stylesheet URL
        if c_doc.URL is NULL:
            doc_url_utf = python.PyUnicode_AsASCIIString(
                f"string://__STRING__XSLT__/{id(self)}.xslt")
            c_doc.URL = tree.xmlStrdup(_xcstr(doc_url_utf))

        self._error_log = _ErrorLog()
        self._xslt_resolver_context = _XSLTResolverContext()
        _initXSLTResolverContext(self._xslt_resolver_context, doc._parser)
        # keep a copy in case we need to access the stylesheet via 'document()'
        self._xslt_resolver_context._c_style_doc = _copyDoc(c_doc, 1)
        c_doc._private = <python.PyObject*>self._xslt_resolver_context

        with self._error_log:
            orig_loader = _register_document_loader()
            c_style = xslt.xsltParseStylesheetDoc(c_doc)
            _reset_document_loader(orig_loader)

        if c_style is NULL or c_style.errors:
            tree.xmlFreeDoc(c_doc)
            if c_style is not NULL:
                xslt.xsltFreeStylesheet(c_style)
            self._xslt_resolver_context._raise_if_stored()
            # last error seems to be the most accurate here
            if self._error_log.last_error is not None and \
                    self._error_log.last_error.message:
                raise XSLTParseError(self._error_log.last_error.message,
                                     self._error_log)
            else:
                raise XSLTParseError(
                    self._error_log._buildExceptionMessage(
                        "Cannot parse stylesheet"),
                    self._error_log)

        c_doc._private = NULL # no longer used!
        self._c_style = c_style
        self._context = _XSLTContext(None, extensions, self._error_log, regexp, True)

    def __dealloc__(self):
        if self._xslt_resolver_context is not None and \
               self._xslt_resolver_context._c_style_doc is not NULL:
            tree.xmlFreeDoc(self._xslt_resolver_context._c_style_doc)
        # this cleans up the doc copy as well
        if self._c_style is not NULL:
            xslt.xsltFreeStylesheet(self._c_style)

    @property
    def error_log(self):
        """The log of errors and warnings of an XSLT execution."""
        return self._error_log.copy()

    @staticmethod
    def strparam(strval):
        """strparam(strval)

        Mark an XSLT string parameter that requires quote escaping
        before passing it into the transformation.  Use it like this::

            result = transform(doc, some_strval = XSLT.strparam(
                '''it's \"Monty Python's\" ...'''))

        Escaped string parameters can be reused without restriction.
        """
        return _XSLTQuotedStringParam(strval)

    @staticmethod
    def set_global_max_depth(int max_depth):
        """set_global_max_depth(max_depth)

        The maximum traversal depth that the stylesheet engine will allow.
        This does not only count the template recursion depth but also takes
        the number of variables/parameters into account.  The required setting
        for a run depends on both the stylesheet and the input data.

        Example::

            XSLT.set_global_max_depth(5000)

        Note that this is currently a global, module-wide setting because
        libxslt does not support it at a per-stylesheet level.
        """
        if max_depth < 0:
            raise ValueError("cannot set a maximum stylesheet traversal depth < 0")
        xslt.xsltMaxDepth = max_depth

    def tostring(self, _ElementTree result_tree):
        """tostring(self, result_tree)

        Save result doc to string based on stylesheet output method.

        :deprecated: use str(result_tree) instead.
        """
        return str(result_tree)

    def __deepcopy__(self, memo):
        return self.__copy__()

    def __copy__(self):
        return _copyXSLT(self)

    def __call__(self, _input, *, profile_run=False, **kw):
        """__call__(self, _input, profile_run=False, **kw)

        Execute the XSL transformation on a tree or Element.

        Pass the ``profile_run`` option to get profile information
        about the XSLT.  The result of the XSLT will have a property
        xslt_profile that holds an XML tree with profiling data.
        """
        cdef _XSLTContext context = None
        cdef _XSLTResolverContext resolver_context
        cdef _Document input_doc
        cdef _Element root_node
        cdef _Document result_doc
        cdef _Document profile_doc = None
        cdef xmlDoc* c_profile_doc
        cdef xslt.xsltTransformContext* transform_ctxt
        cdef xmlDoc* c_result = NULL
        cdef xmlDoc* c_doc
        cdef tree.xmlDict* c_dict
        cdef const_char** params = NULL

        assert self._c_style is not NULL, "XSLT stylesheet not initialised"
        input_doc = _documentOrRaise(_input)
        root_node = _rootNodeOrRaise(_input)

        c_doc = _fakeRootDoc(input_doc._c_doc, root_node._c_node)

        transform_ctxt = xslt.xsltNewTransformContext(self._c_style, c_doc)
        if transform_ctxt is NULL:
            _destroyFakeDoc(input_doc._c_doc, c_doc)
            raise MemoryError()

        # using the stylesheet dict is safer than using a possibly
        # unrelated dict from the current thread.  Almost all
        # non-input tag/attr names will come from the stylesheet
        # anyway.
        if transform_ctxt.dict is not NULL:
            xmlparser.xmlDictFree(transform_ctxt.dict)
        if kw:
            # parameter values are stored in the dict
            # => avoid unnecessarily cluttering the global dict
            transform_ctxt.dict = xmlparser.xmlDictCreateSub(self._c_style.doc.dict)
            if transform_ctxt.dict is NULL:
                xslt.xsltFreeTransformContext(transform_ctxt)
                raise MemoryError()
        else:
            transform_ctxt.dict = self._c_style.doc.dict
            xmlparser.xmlDictReference(transform_ctxt.dict)

        xslt.xsltSetCtxtParseOptions(
            transform_ctxt, input_doc._parser._parse_options)

        if profile_run:
            transform_ctxt.profile = 1

        try:
            context = self._context._copy()
            context.register_context(transform_ctxt, input_doc)

            resolver_context = self._xslt_resolver_context._copy()
            transform_ctxt._private = <python.PyObject*>resolver_context

            _convert_xslt_parameters(transform_ctxt, kw, &params)
            c_result = self._run_transform(
                c_doc, params, context, transform_ctxt)
            if params is not NULL:
                # deallocate space for parameters
                python.lxml_free(params)

            if transform_ctxt.state != xslt.XSLT_STATE_OK:
                if c_result is not NULL:
                    tree.xmlFreeDoc(c_result)
                    c_result = NULL

            if transform_ctxt.profile:
                c_profile_doc = xslt.xsltGetProfileInformation(transform_ctxt)
                if c_profile_doc is not NULL:
                    profile_doc = _documentFactory(
                        c_profile_doc, input_doc._parser)
        finally:
            if context is not None:
                context.free_context()
            _destroyFakeDoc(input_doc._c_doc, c_doc)

        try:
            if resolver_context is not None and resolver_context._has_raised():
                if c_result is not NULL:
                    tree.xmlFreeDoc(c_result)
                    c_result = NULL
                resolver_context._raise_if_stored()

            if context._exc._has_raised():
                if c_result is not NULL:
                    tree.xmlFreeDoc(c_result)
                    c_result = NULL
                context._exc._raise_if_stored()

            if c_result is NULL:
                # last error seems to be the most accurate here
                error = self._error_log.last_error
                if error is not None and error.message:
                    if error.line > 0:
                        message = f"{error.message}, line {error.line}"
                    else:
                        message = error.message
                elif error is not None and error.line > 0:
                    message = f"Error applying stylesheet, line {error.line}"
                else:
                    message = "Error applying stylesheet"
                raise XSLTApplyError(message, self._error_log)
        finally:
            if resolver_context is not None:
                resolver_context.clear()

        result_doc = _documentFactory(c_result, input_doc._parser)

        c_dict = c_result.dict
        xmlparser.xmlDictReference(c_dict)
        __GLOBAL_PARSER_CONTEXT.initThreadDictRef(&c_result.dict)
        if c_dict is not c_result.dict or \
                self._c_style.doc.dict is not c_result.dict or \
                input_doc._c_doc.dict is not c_result.dict:
            with nogil:
                if c_dict is not c_result.dict:
                    fixThreadDictNames(<xmlNode*>c_result,
                                       c_dict, c_result.dict)
                if self._c_style.doc.dict is not c_result.dict:
                    fixThreadDictNames(<xmlNode*>c_result,
                                       self._c_style.doc.dict, c_result.dict)
                if input_doc._c_doc.dict is not c_result.dict:
                    fixThreadDictNames(<xmlNode*>c_result,
                                       input_doc._c_doc.dict, c_result.dict)
        xmlparser.xmlDictFree(c_dict)

        return _xsltResultTreeFactory(result_doc, self, profile_doc)

    cdef xmlDoc* _run_transform(self, xmlDoc* c_input_doc,
                                const_char** params, _XSLTContext context,
                                xslt.xsltTransformContext* transform_ctxt):
        cdef xmlDoc* c_result
        xslt.xsltSetTransformErrorFunc(transform_ctxt, <void*>self._error_log,
                                       <xmlerror.xmlGenericErrorFunc>_receiveXSLTError)
        if self._access_control is not None:
            self._access_control._register_in_context(transform_ctxt)
        with self._error_log, nogil:
            orig_loader = _register_document_loader()
            c_result = xslt.xsltApplyStylesheetUser(
                self._c_style, c_input_doc, params, NULL, NULL, transform_ctxt)
            _reset_document_loader(orig_loader)
        return c_result


cdef _convert_xslt_parameters(xslt.xsltTransformContext* transform_ctxt,
                              dict parameters, const_char*** params_ptr):
    cdef Py_ssize_t i, parameter_count
    cdef const_char** params
    cdef tree.xmlDict* c_dict = transform_ctxt.dict
    params_ptr[0] = NULL
    parameter_count = len(parameters)
    if parameter_count == 0:
        return
    # allocate space for parameters
    # * 2 as we want an entry for both key and value,
    # and + 1 as array is NULL terminated
    params = <const_char**>python.lxml_malloc(parameter_count * 2 + 1, sizeof(const_char*))
    if not params:
        raise MemoryError()
    try:
        i = 0
        for key, value in parameters.iteritems():
            k = _utf8(key)
            if isinstance(value, _XSLTQuotedStringParam):
                v = (<_XSLTQuotedStringParam>value).strval
                xslt.xsltQuoteOneUserParam(
                    transform_ctxt, _xcstr(k), _xcstr(v))
            else:
                if isinstance(value, XPath):
                    v = (<XPath>value)._path
                else:
                    v = _utf8(value)

                c_len = len(k)
                if c_len > limits.INT_MAX:
                    raise ValueError("Parameter name too long")
                params[i] = <const_char*> tree.xmlDictLookup(c_dict, _xcstr(k), <int> c_len)
                i += 1
                c_len = len(v)
                if c_len > limits.INT_MAX:
                    raise ValueError("Parameter value too long")
                params[i] = <const_char*> tree.xmlDictLookup(c_dict, _xcstr(v), <int> c_len)
                i += 1
    except:
        python.lxml_free(params)
        raise
    params[i] = NULL
    params_ptr[0] = params

cdef XSLT _copyXSLT(XSLT stylesheet):
    cdef XSLT new_xslt
    cdef xmlDoc* c_doc
    assert stylesheet._c_style is not NULL, "XSLT stylesheet not initialised"
    new_xslt = XSLT.__new__(XSLT)
    new_xslt._access_control = stylesheet._access_control
    new_xslt._error_log = _ErrorLog()
    new_xslt._context = stylesheet._context._copy()

    new_xslt._xslt_resolver_context = stylesheet._xslt_resolver_context._copy()
    new_xslt._xslt_resolver_context._c_style_doc = _copyDoc(
        stylesheet._xslt_resolver_context._c_style_doc, 1)

    c_doc = _copyDoc(stylesheet._c_style.doc, 1)
    new_xslt._c_style = xslt.xsltParseStylesheetDoc(c_doc)
    if new_xslt._c_style is NULL:
        tree.xmlFreeDoc(c_doc)
        raise MemoryError()

    return new_xslt

@cython.final
cdef class _XSLTResultTree(_ElementTree):
    """The result of an XSLT evaluation.

    Use ``str()`` or ``bytes()`` (or ``unicode()`` in Python 2.x) to serialise to a string,
    and the ``.write_output()`` method to write serialise to a file.
    """
    cdef XSLT _xslt
    cdef _Document _profile
    cdef xmlChar* _buffer
    cdef Py_ssize_t _buffer_len
    cdef Py_ssize_t _buffer_refcnt

    def write_output(self, file, *, compression=0):
        """write_output(self, file, *, compression=0)

        Serialise the XSLT output to a file or file-like object.

        As opposed to the generic ``.write()`` method, ``.write_output()`` serialises
        the result as defined by the ``<xsl:output>`` tag.
        """
        cdef _FilelikeWriter writer = None
        cdef _Document doc
        cdef int r, rclose, c_compression
        cdef const_xmlChar* c_encoding = NULL
        cdef tree.xmlOutputBuffer* c_buffer

        if self._context_node is not None:
            doc = self._context_node._doc
        else:
            doc = None
        if doc is None:
            doc = self._doc
            if doc is None:
                raise XSLTSaveError("No document to serialise")
        c_compression = compression or 0
        xslt.LXML_GET_XSLT_ENCODING(c_encoding, self._xslt._c_style)
        writer = _create_output_buffer(file, <const_char*>c_encoding, c_compression, &c_buffer, close=False)
        if writer is None:
            with nogil:
                r = xslt.xsltSaveResultTo(c_buffer, doc._c_doc, self._xslt._c_style)
                rclose = tree.xmlOutputBufferClose(c_buffer)
        else:
            r = xslt.xsltSaveResultTo(c_buffer, doc._c_doc, self._xslt._c_style)
            rclose = tree.xmlOutputBufferClose(c_buffer)
        if writer is not None:
            writer._exc_context._raise_if_stored()
        if r < 0 or rclose == -1:
            python.PyErr_SetFromErrno(IOError)  # raises IOError

    cdef _saveToStringAndSize(self, xmlChar** s, int* l):
        cdef _Document doc
        cdef int r
        if self._context_node is not None:
            doc = self._context_node._doc
        else:
            doc = None
        if doc is None:
            doc = self._doc
            if doc is None:
                s[0] = NULL
                return
        with nogil:
            r = xslt.xsltSaveResultToString(s, l, doc._c_doc,
                                            self._xslt._c_style)
        if r == -1:
            raise MemoryError()

    def __str__(self):
        cdef xmlChar* encoding
        cdef xmlChar* s = NULL
        cdef int l = 0
        self._saveToStringAndSize(&s, &l)
        if s is NULL:
            return ''
        encoding = self._xslt._c_style.encoding
        try:
            if encoding is NULL:
                result = s[:l].decode('UTF-8')
            else:
                result = s[:l].decode(encoding)
        finally:
            tree.xmlFree(s)
        return _stripEncodingDeclaration(result)

    def __getbuffer__(self, Py_buffer* buffer, int flags):
        cdef int l = 0
        if buffer is NULL:
            return
        if self._buffer is NULL or flags & python.PyBUF_WRITABLE:
            self._saveToStringAndSize(<xmlChar**>&buffer.buf, &l)
            buffer.len = l
            if self._buffer is NULL and not flags & python.PyBUF_WRITABLE:
                self._buffer = <xmlChar*>buffer.buf
                self._buffer_len = l
                self._buffer_refcnt = 1
        else:
            buffer.buf = self._buffer
            buffer.len = self._buffer_len
            self._buffer_refcnt += 1
        if flags & python.PyBUF_WRITABLE:
            buffer.readonly = 0
        else:
            buffer.readonly = 1
        if flags & python.PyBUF_FORMAT:
            buffer.format = "B"
        else:
            buffer.format = NULL
        buffer.ndim = 0
        buffer.shape = NULL
        buffer.strides = NULL
        buffer.suboffsets = NULL
        buffer.itemsize = 1
        buffer.internal = NULL
        if buffer.obj is not self: # set by Cython?
            buffer.obj = self

    def __releasebuffer__(self, Py_buffer* buffer):
        if buffer is NULL:
            return
        if <xmlChar*>buffer.buf is self._buffer:
            self._buffer_refcnt -= 1
            if self._buffer_refcnt == 0:
                tree.xmlFree(<char*>self._buffer)
                self._buffer = NULL
        else:
            tree.xmlFree(<char*>buffer.buf)
        buffer.buf = NULL

    property xslt_profile:
        """Return an ElementTree with profiling data for the stylesheet run.
        """
        def __get__(self):
            cdef object root
            if self._profile is None:
                return None
            root = self._profile.getroot()
            if root is None:
                return None
            return ElementTree(root)

        def __del__(self):
            self._profile = None

cdef _xsltResultTreeFactory(_Document doc, XSLT xslt, _Document profile):
    cdef _XSLTResultTree result
    result = <_XSLTResultTree>_newElementTree(doc, None, _XSLTResultTree)
    result._xslt = xslt
    result._profile = profile
    return result

# functions like "output" and "write" are a potential security risk, but we
# rely on the user to configure XSLTAccessControl as needed
xslt.xsltRegisterAllExtras()

# enable EXSLT support for XSLT
xslt.exsltRegisterAll()


################################################################################
# XSLT PI support

cdef object _RE_PI_HREF = re.compile(r'\s+href\s*=\s*(?:\'([^\']*)\'|"([^"]*)")')
cdef object _FIND_PI_HREF = _RE_PI_HREF.findall
cdef object _REPLACE_PI_HREF = _RE_PI_HREF.sub
cdef XPath __findStylesheetByID = None

cdef _findStylesheetByID(_Document doc, id):
    global __findStylesheetByID
    if __findStylesheetByID is None:
        __findStylesheetByID = XPath(
            "//xsl:stylesheet[@xml:id = $id]",
            namespaces={"xsl" : "http://www.w3.org/1999/XSL/Transform"})
    return __findStylesheetByID(doc, id=id)

cdef class _XSLTProcessingInstruction(PIBase):
    def parseXSL(self, parser=None):
        """parseXSL(self, parser=None)

        Try to parse the stylesheet referenced by this PI and return
        an ElementTree for it.  If the stylesheet is embedded in the
        same document (referenced via xml:id), find and return an
        ElementTree for the stylesheet Element.

        The optional ``parser`` keyword argument can be passed to specify the
        parser used to read from external stylesheet URLs.
        """
        cdef _Document result_doc
        cdef _Element  result_node
        cdef bytes href_utf
        cdef const_xmlChar* c_href
        cdef xmlAttr* c_attr
        _assertValidNode(self)
        if self._c_node.content is NULL:
            raise ValueError, "PI lacks content"
        hrefs = _FIND_PI_HREF(' ' + (<unsigned char*>self._c_node.content).decode('UTF-8'))
        if len(hrefs) != 1:
            raise ValueError, "malformed PI attributes"
        hrefs = hrefs[0]
        href_utf = utf8(hrefs[0] or hrefs[1])
        c_href = _xcstr(href_utf)

        if c_href[0] != c'#':
            # normal URL, try to parse from it
            c_href = tree.xmlBuildURI(
                c_href,
                tree.xmlNodeGetBase(self._c_node.doc, self._c_node))
            if c_href is not NULL:
                try:
                    href_utf = <unsigned char*>c_href
                finally:
                    tree.xmlFree(<char*>c_href)
            result_doc = _parseDocumentFromURL(href_utf, parser)
            return _elementTreeFactory(result_doc, None)

        # ID reference to embedded stylesheet
        # try XML:ID lookup
        _assertValidDoc(self._doc)
        c_href += 1 # skip leading '#'
        c_attr = tree.xmlGetID(self._c_node.doc, c_href)
        if c_attr is not NULL and c_attr.doc is self._c_node.doc:
            result_node = _elementFactory(self._doc, c_attr.parent)
            return _elementTreeFactory(result_node._doc, result_node)

        # try XPath search
        root = _findStylesheetByID(self._doc, funicode(c_href))
        if not root:
            raise ValueError, "reference to non-existing embedded stylesheet"
        elif len(root) > 1:
            raise ValueError, "ambiguous reference to embedded stylesheet"
        result_node = root[0]
        return _elementTreeFactory(result_node._doc, result_node)

    def set(self, key, value):
        """set(self, key, value)

        Supports setting the 'href' pseudo-attribute in the text of
        the processing instruction.
        """
        if key != "href":
            raise AttributeError, \
                "only setting the 'href' attribute is supported on XSLT-PIs"
        if value is None:
            attrib = ""
        elif '"' in value or '>' in value:
            raise ValueError, "Invalid URL, must not contain '\"' or '>'"
        else:
            attrib = f' href="{value}"'
        text = ' ' + self.text
        if _FIND_PI_HREF(text):
            self.text = _REPLACE_PI_HREF(attrib, text)
        else:
            self.text = text + attrib
