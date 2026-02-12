# support for Schematron validation
from lxml.includes cimport schematron


cdef class SchematronError(LxmlError):
    """Base class of all Schematron errors.
    """

cdef class SchematronParseError(SchematronError):
    """Error while parsing an XML document as Schematron schema.
    """

cdef class SchematronValidateError(SchematronError):
    """Error while validating an XML document with a Schematron schema.
    """


################################################################################
# Schematron

cdef class Schematron(_Validator):
    """Schematron(self, etree=None, file=None)
    A Schematron validator.

    Pass a root Element or an ElementTree to turn it into a validator.
    Alternatively, pass a filename as keyword argument 'file' to parse from
    the file system.

    Schematron is a less well known, but very powerful schema language.  The main
    idea is to use the capabilities of XPath to put restrictions on the structure
    and the content of XML documents.  Here is a simple example::

      >>> schematron = Schematron(XML('''
      ... <schema xmlns="http://www.ascc.net/xml/schematron" >
      ...   <pattern name="id is the only permitted attribute name">
      ...     <rule context="*">
      ...       <report test="@*[not(name()='id')]">Attribute
      ...         <name path="@*[not(name()='id')]"/> is forbidden<name/>
      ...       </report>
      ...     </rule>
      ...   </pattern>
      ... </schema>
      ... '''))

      >>> xml = XML('''
      ... <AAA name="aaa">
      ...   <BBB id="bbb"/>
      ...   <CCC color="ccc"/>
      ... </AAA>
      ... ''')

      >>> schematron.validate(xml)
      0

      >>> xml = XML('''
      ... <AAA id="aaa">
      ...   <BBB id="bbb"/>
      ...   <CCC/>
      ... </AAA>
      ... ''')

      >>> schematron.validate(xml)
      1

    Schematron was added to libxml2 in version 2.6.21.  Before version 2.6.32,
    however, Schematron lacked support for error reporting other than to stderr.
    This version is therefore required to retrieve validation warnings and
    errors in lxml.
    """
    cdef schematron.xmlSchematron* _c_schema
    cdef xmlDoc* _c_schema_doc

    def __init__(self, etree=None, *, file=None):
        cdef _Document doc
        cdef _Element root_node
        cdef xmlNode* c_node
        cdef char* c_href
        cdef schematron.xmlSchematronParserCtxt* parser_ctxt = NULL
        _Validator.__init__(self)
        if not config.ENABLE_SCHEMATRON:
            raise SchematronError, \
                "lxml.etree was compiled without Schematron support."

        import warnings
        warnings.warn(
            "The (non-ISO) Schematron feature is deprecated and will be removed from libxml2 and lxml. "
            "Use 'lxml.isoschematron' instead.",
            DeprecationWarning,
        )

        if etree is not None:
            doc = _documentOrRaise(etree)
            root_node = _rootNodeOrRaise(etree)
            self._c_schema_doc = _copyDocRoot(doc._c_doc, root_node._c_node)
            parser_ctxt = schematron.xmlSchematronNewDocParserCtxt(self._c_schema_doc)
        elif file is not None:
            filename = _getFilenameForFile(file)
            if filename is None:
                # XXX assume a string object
                filename = file
            filename = _encodeFilename(filename)
            with self._error_log:
                orig_loader = _register_document_loader()
                parser_ctxt = schematron.xmlSchematronNewParserCtxt(_cstr(filename))
                _reset_document_loader(orig_loader)
        else:
            raise SchematronParseError, "No tree or file given"

        if parser_ctxt is NULL:
            if self._c_schema_doc is not NULL:
                tree.xmlFreeDoc(self._c_schema_doc)
                self._c_schema_doc = NULL
            raise MemoryError()

        try:
            with self._error_log:
                orig_loader = _register_document_loader()
                self._c_schema = schematron.xmlSchematronParse(parser_ctxt)
                _reset_document_loader(orig_loader)
        finally:
            schematron.xmlSchematronFreeParserCtxt(parser_ctxt)

        if self._c_schema is NULL:
            raise SchematronParseError(
                "Document is not a valid Schematron schema",
                self._error_log)

    def __dealloc__(self):
        schematron.xmlSchematronFree(self._c_schema)
        if self._c_schema_doc is not NULL:
            tree.xmlFreeDoc(self._c_schema_doc)

    def __call__(self, etree):
        """__call__(self, etree)

        Validate doc using Schematron.

        Returns true if document is valid, false if not."""
        cdef _Document doc
        cdef _Element root_node
        cdef xmlDoc* c_doc
        cdef schematron.xmlSchematronValidCtxt* valid_ctxt
        cdef int ret

        assert self._c_schema is not NULL, "Schematron instance not initialised"
        doc = _documentOrRaise(etree)
        root_node = _rootNodeOrRaise(etree)

        valid_ctxt = schematron.xmlSchematronNewValidCtxt(
            self._c_schema, schematron.XML_SCHEMATRON_OUT_ERROR)
        if valid_ctxt is NULL:
            raise MemoryError()

        try:
            self._error_log.clear()
            # Need a cast here because older libxml2 releases do not use 'const' in the functype.
            schematron.xmlSchematronSetValidStructuredErrors(
                valid_ctxt, <xmlerror.xmlStructuredErrorFunc> _receiveError, <void*>self._error_log)
            c_doc = _fakeRootDoc(doc._c_doc, root_node._c_node)
            with nogil:
                ret = schematron.xmlSchematronValidateDoc(valid_ctxt, c_doc)
            _destroyFakeDoc(doc._c_doc, c_doc)
        finally:
            schematron.xmlSchematronFreeValidCtxt(valid_ctxt)

        if ret == -1:
            raise SchematronValidateError(
                "Internal error in Schematron validation",
                self._error_log)
        if ret == 0:
            return True
        else:
            return False
