#  support for XMLSchema validation
from lxml.includes cimport xmlschema


cdef class XMLSchemaError(LxmlError):
    """Base class of all XML Schema errors
    """

cdef class XMLSchemaParseError(XMLSchemaError):
    """Error while parsing an XML document as XML Schema.
    """

cdef class XMLSchemaValidateError(XMLSchemaError):
    """Error while validating an XML document with an XML Schema.
    """


################################################################################
# XMLSchema

cdef XPath _check_for_default_attributes = XPath(
    "boolean(//xs:attribute[@default or @fixed][1])",
    namespaces={'xs': 'http://www.w3.org/2001/XMLSchema'})


cdef class XMLSchema(_Validator):
    """XMLSchema(self, etree=None, file=None)
    Turn a document into an XML Schema validator.

    Either pass a schema as Element or ElementTree, or pass a file or
    filename through the ``file`` keyword argument.

    Passing the ``attribute_defaults`` boolean option will make the
    schema insert default/fixed attributes into validated documents.
    """
    cdef xmlschema.xmlSchema* _c_schema
    cdef _Document _doc
    cdef bint _has_default_attributes
    cdef bint _add_attribute_defaults

    def __cinit__(self):
        self._has_default_attributes = True # play it safe
        self._add_attribute_defaults = False

    def __init__(self, etree=None, *, file=None, bint attribute_defaults=False):
        cdef xmlschema.xmlSchemaParserCtxt* parser_ctxt
        cdef xmlDoc* c_doc

        self._add_attribute_defaults = attribute_defaults
        _Validator.__init__(self)
        c_doc = NULL
        if etree is not None:
            doc = _documentOrRaise(etree)
            root_node = _rootNodeOrRaise(etree)
            c_doc = _copyDocRoot(doc._c_doc, root_node._c_node)
            self._doc = _documentFactory(c_doc, doc._parser)
            parser_ctxt = xmlschema.xmlSchemaNewDocParserCtxt(c_doc)
        elif file is not None:
            file = _getFSPathOrObject(file)
            if _isString(file):
                filename = _encodeFilename(file)
                parser_ctxt = xmlschema.xmlSchemaNewParserCtxt(_cstr(filename))
            else:
                self._doc = _parseDocument(file, None, None)
                parser_ctxt = xmlschema.xmlSchemaNewDocParserCtxt(self._doc._c_doc)
        else:
            raise XMLSchemaParseError, "No tree or file given"

        if parser_ctxt is NULL:
            raise MemoryError()

        # Need a cast here because older libxml2 releases do not use 'const' in the functype.
        xmlschema.xmlSchemaSetParserStructuredErrors(
            parser_ctxt, <xmlerror.xmlStructuredErrorFunc> _receiveError, <void*>self._error_log)
        if self._doc is not None:
            # calling xmlSchemaParse on a schema with imports or
            # includes will cause libxml2 to create an internal
            # context for parsing, so push an implied context to route
            # resolve requests to the document's parser
            __GLOBAL_PARSER_CONTEXT.pushImpliedContextFromParser(self._doc._parser)
        with nogil:
            orig_loader = _register_document_loader()
            self._c_schema = xmlschema.xmlSchemaParse(parser_ctxt)
            _reset_document_loader(orig_loader)
        if self._doc is not None:
            __GLOBAL_PARSER_CONTEXT.popImpliedContext()
        xmlschema.xmlSchemaFreeParserCtxt(parser_ctxt)

        if self._c_schema is NULL:
            raise XMLSchemaParseError(
                self._error_log._buildExceptionMessage(
                    "Document is not valid XML Schema"),
                self._error_log)

        if self._doc is not None:
            self._has_default_attributes = _check_for_default_attributes(self._doc)
        self._add_attribute_defaults = attribute_defaults and self._has_default_attributes

    def __dealloc__(self):
        xmlschema.xmlSchemaFree(self._c_schema)

    def __call__(self, etree):
        """__call__(self, etree)

        Validate doc using XML Schema.

        Returns true if document is valid, false if not.
        """
        cdef xmlschema.xmlSchemaValidCtxt* valid_ctxt
        cdef _Document doc
        cdef _Element root_node
        cdef xmlDoc* c_doc
        cdef int ret

        assert self._c_schema is not NULL, "Schema instance not initialised"
        doc = _documentOrRaise(etree)
        root_node = _rootNodeOrRaise(etree)

        valid_ctxt = xmlschema.xmlSchemaNewValidCtxt(self._c_schema)
        if valid_ctxt is NULL:
            raise MemoryError()

        try:
            if self._add_attribute_defaults:
                xmlschema.xmlSchemaSetValidOptions(
                    valid_ctxt, xmlschema.XML_SCHEMA_VAL_VC_I_CREATE)

            self._error_log.clear()
            # Need a cast here because older libxml2 releases do not use 'const' in the functype.
            xmlschema.xmlSchemaSetValidStructuredErrors(
                valid_ctxt, <xmlerror.xmlStructuredErrorFunc> _receiveError, <void*>self._error_log)

            c_doc = _fakeRootDoc(doc._c_doc, root_node._c_node)
            with nogil:
                ret = xmlschema.xmlSchemaValidateDoc(valid_ctxt, c_doc)
            _destroyFakeDoc(doc._c_doc, c_doc)
        finally:
            xmlschema.xmlSchemaFreeValidCtxt(valid_ctxt)

        if ret == -1:
            raise XMLSchemaValidateError(
                "Internal error in XML Schema validation.",
                self._error_log)
        if ret == 0:
            return True
        else:
            return False

    cdef _ParserSchemaValidationContext _newSaxValidator(
            self, bint add_default_attributes):
        cdef _ParserSchemaValidationContext context
        context = _ParserSchemaValidationContext.__new__(_ParserSchemaValidationContext)
        context._schema = self
        context._add_default_attributes = (self._has_default_attributes and (
            add_default_attributes or self._add_attribute_defaults))
        return context

@cython.final
@cython.internal
cdef class _ParserSchemaValidationContext:
    cdef XMLSchema _schema
    cdef xmlschema.xmlSchemaValidCtxt* _valid_ctxt
    cdef xmlschema.xmlSchemaSAXPlugStruct* _sax_plug
    cdef bint _add_default_attributes
    def __cinit__(self):
        self._valid_ctxt = NULL
        self._sax_plug = NULL
        self._add_default_attributes = False

    def __dealloc__(self):
        self.disconnect()
        if self._valid_ctxt:
            xmlschema.xmlSchemaFreeValidCtxt(self._valid_ctxt)

    cdef _ParserSchemaValidationContext copy(self):
        assert self._schema is not None, "_ParserSchemaValidationContext not initialised"
        return self._schema._newSaxValidator(
            self._add_default_attributes)

    cdef void inject_default_attributes(self, xmlDoc* c_doc) noexcept:
        # we currently need to insert default attributes manually
        # after parsing, as libxml2 does not support this at parse
        # time
        if self._add_default_attributes:
            with nogil:
                xmlschema.xmlSchemaValidateDoc(self._valid_ctxt, c_doc)

    cdef int connect(self, xmlparser.xmlParserCtxt* c_ctxt, _BaseErrorLog error_log) except -1:
        if self._valid_ctxt is NULL:
            self._valid_ctxt = xmlschema.xmlSchemaNewValidCtxt(
                self._schema._c_schema)
            if self._valid_ctxt is NULL:
                raise MemoryError()
            if self._add_default_attributes:
                xmlschema.xmlSchemaSetValidOptions(
                    self._valid_ctxt, xmlschema.XML_SCHEMA_VAL_VC_I_CREATE)
        if error_log is not None:
            # Need a cast here because older libxml2 releases do not use 'const' in the functype.
            xmlschema.xmlSchemaSetValidStructuredErrors(
                self._valid_ctxt, <xmlerror.xmlStructuredErrorFunc> _receiveError, <void*>error_log)
        self._sax_plug = xmlschema.xmlSchemaSAXPlug(
            self._valid_ctxt, &c_ctxt.sax, &c_ctxt.userData)

    cdef void disconnect(self) noexcept:
        if self._sax_plug is not NULL:
            xmlschema.xmlSchemaSAXUnplug(self._sax_plug)
            self._sax_plug = NULL
        if self._valid_ctxt is not NULL:
            xmlschema.xmlSchemaSetValidStructuredErrors(
                self._valid_ctxt, NULL, NULL)

    cdef bint isvalid(self) noexcept:
        if self._valid_ctxt is NULL:
            return 1 # valid
        return xmlschema.xmlSchemaIsValid(self._valid_ctxt)
