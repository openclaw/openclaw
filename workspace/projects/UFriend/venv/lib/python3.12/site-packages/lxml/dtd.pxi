# support for DTD validation
from lxml.includes cimport dtdvalid

cdef class DTDError(LxmlError):
    """Base class for DTD errors.
    """

cdef class DTDParseError(DTDError):
    """Error while parsing a DTD.
    """

cdef class DTDValidateError(DTDError):
    """Error while validating an XML document with a DTD.
    """


cdef inline int _assertValidDTDNode(node, void *c_node) except -1:
    assert c_node is not NULL, "invalid DTD proxy at %s" % id(node)


@cython.final
@cython.internal
@cython.freelist(8)
cdef class _DTDElementContentDecl:
    cdef DTD _dtd
    cdef tree.xmlElementContent* _c_node

    def __repr__(self):
        return "<%s.%s object name=%r type=%r occur=%r at 0x%x>" % (self.__class__.__module__, self.__class__.__name__, self.name, self.type, self.occur, id(self))

    @property
    def name(self):
       _assertValidDTDNode(self, self._c_node)
       return funicodeOrNone(self._c_node.name)

    @property
    def type(self):
       _assertValidDTDNode(self, self._c_node)
       cdef int type = self._c_node.type
       if type == tree.XML_ELEMENT_CONTENT_PCDATA:
           return "pcdata"
       elif type == tree.XML_ELEMENT_CONTENT_ELEMENT:
           return "element"
       elif type == tree.XML_ELEMENT_CONTENT_SEQ:
           return "seq"
       elif type == tree.XML_ELEMENT_CONTENT_OR:
           return "or"
       else:
           return None

    @property
    def occur(self):
       _assertValidDTDNode(self, self._c_node)
       cdef int occur = self._c_node.ocur
       if occur == tree.XML_ELEMENT_CONTENT_ONCE:
           return "once"
       elif occur == tree.XML_ELEMENT_CONTENT_OPT:
           return "opt"
       elif occur == tree.XML_ELEMENT_CONTENT_MULT:
           return "mult"
       elif occur == tree.XML_ELEMENT_CONTENT_PLUS:
           return "plus"
       else:
           return None

    @property
    def left(self):
       _assertValidDTDNode(self, self._c_node)
       c1 = self._c_node.c1
       if c1:
           node = <_DTDElementContentDecl>_DTDElementContentDecl.__new__(_DTDElementContentDecl)
           node._dtd = self._dtd
           node._c_node = <tree.xmlElementContent*>c1
           return node
       else:
           return None

    @property
    def right(self):
       _assertValidDTDNode(self, self._c_node)
       c2 = self._c_node.c2
       if c2:
           node = <_DTDElementContentDecl>_DTDElementContentDecl.__new__(_DTDElementContentDecl)
           node._dtd = self._dtd
           node._c_node = <tree.xmlElementContent*>c2
           return node
       else:
           return None


@cython.final
@cython.internal
@cython.freelist(8)
cdef class _DTDAttributeDecl:
    cdef DTD _dtd
    cdef tree.xmlAttribute* _c_node

    def __repr__(self):
        return "<%s.%s object name=%r elemname=%r prefix=%r type=%r default=%r default_value=%r at 0x%x>" % (self.__class__.__module__, self.__class__.__name__, self.name, self.elemname, self.prefix, self.type, self.default, self.default_value, id(self))

    @property
    def name(self):
       _assertValidDTDNode(self, self._c_node)
       return funicodeOrNone(self._c_node.name)

    @property
    def elemname(self):
       _assertValidDTDNode(self, self._c_node)
       return funicodeOrNone(self._c_node.elem)

    @property
    def prefix(self):
       _assertValidDTDNode(self, self._c_node)
       return funicodeOrNone(self._c_node.prefix)

    @property
    def type(self):
       _assertValidDTDNode(self, self._c_node)
       cdef int type = self._c_node.atype
       if type == tree.XML_ATTRIBUTE_CDATA:
           return "cdata"
       elif type == tree.XML_ATTRIBUTE_ID:
           return "id"
       elif type == tree.XML_ATTRIBUTE_IDREF:
           return "idref"
       elif type == tree.XML_ATTRIBUTE_IDREFS:
           return "idrefs"
       elif type == tree.XML_ATTRIBUTE_ENTITY:
           return "entity"
       elif type == tree.XML_ATTRIBUTE_ENTITIES:
           return "entities"
       elif type == tree.XML_ATTRIBUTE_NMTOKEN:
           return "nmtoken"
       elif type == tree.XML_ATTRIBUTE_NMTOKENS:
           return "nmtokens"
       elif type == tree.XML_ATTRIBUTE_ENUMERATION:
           return "enumeration"
       elif type == tree.XML_ATTRIBUTE_NOTATION:
           return "notation"
       else:
           return None

    @property
    def default(self):
       _assertValidDTDNode(self, self._c_node)
       cdef int default = self._c_node.def_
       if default == tree.XML_ATTRIBUTE_NONE:
           return "none"
       elif default == tree.XML_ATTRIBUTE_REQUIRED:
           return "required"
       elif default == tree.XML_ATTRIBUTE_IMPLIED:
           return "implied"
       elif default == tree.XML_ATTRIBUTE_FIXED:
           return "fixed"
       else:
           return None

    @property
    def default_value(self):
       _assertValidDTDNode(self, self._c_node)
       return funicodeOrNone(self._c_node.defaultValue)

    def itervalues(self):
        _assertValidDTDNode(self, self._c_node)
        cdef tree.xmlEnumeration *c_node = self._c_node.tree
        while c_node is not NULL:
            yield funicode(c_node.name)
            c_node = c_node.next

    def values(self):
        return list(self.itervalues())


@cython.final
@cython.internal
@cython.freelist(8)
cdef class _DTDElementDecl:
    cdef DTD _dtd
    cdef tree.xmlElement* _c_node

    def __repr__(self):
        return "<%s.%s object name=%r prefix=%r type=%r at 0x%x>" % (self.__class__.__module__, self.__class__.__name__, self.name, self.prefix, self.type, id(self))

    @property
    def name(self):
        _assertValidDTDNode(self, self._c_node)
        return funicodeOrNone(self._c_node.name)

    @property
    def prefix(self):
       _assertValidDTDNode(self, self._c_node)
       return funicodeOrNone(self._c_node.prefix)

    @property
    def type(self):
       _assertValidDTDNode(self, self._c_node)
       cdef int type = self._c_node.etype
       if type == tree.XML_ELEMENT_TYPE_UNDEFINED:
           return "undefined"
       elif type == tree.XML_ELEMENT_TYPE_EMPTY:
           return "empty"
       elif type == tree.XML_ELEMENT_TYPE_ANY:
           return "any"
       elif type == tree.XML_ELEMENT_TYPE_MIXED:
           return "mixed"
       elif type == tree.XML_ELEMENT_TYPE_ELEMENT:
           return "element"
       else:
           return None

    @property
    def content(self):
       _assertValidDTDNode(self, self._c_node)
       cdef tree.xmlElementContent *content = self._c_node.content
       if content:
           node = <_DTDElementContentDecl>_DTDElementContentDecl.__new__(_DTDElementContentDecl)
           node._dtd = self._dtd
           node._c_node = content
           return node
       else:
           return None

    def iterattributes(self):
        _assertValidDTDNode(self, self._c_node)
        cdef tree.xmlAttribute *c_node = self._c_node.attributes
        while c_node:
            node = <_DTDAttributeDecl>_DTDAttributeDecl.__new__(_DTDAttributeDecl)
            node._dtd = self._dtd
            node._c_node = c_node
            yield node
            c_node = c_node.nexth

    def attributes(self):
        return list(self.iterattributes())


@cython.final
@cython.internal
@cython.freelist(8)
cdef class _DTDEntityDecl:
    cdef DTD _dtd
    cdef tree.xmlEntity* _c_node
    def __repr__(self):
        return "<%s.%s object name=%r at 0x%x>" % (self.__class__.__module__, self.__class__.__name__, self.name, id(self))

    @property
    def name(self):
        _assertValidDTDNode(self, self._c_node)
        return funicodeOrNone(self._c_node.name)

    @property
    def orig(self):
        _assertValidDTDNode(self, self._c_node)
        return funicodeOrNone(self._c_node.orig)

    @property
    def content(self):
        _assertValidDTDNode(self, self._c_node)
        return funicodeOrNone(self._c_node.content)

    @property
    def system_url(self):
        _assertValidDTDNode(self, self._c_node)
        return funicodeOrNone(self._c_node.SystemID)


################################################################################
# DTD

cdef class DTD(_Validator):
    """DTD(self, file=None, external_id=None)
    A DTD validator.

    Can load from filesystem directly given a filename or file-like object.
    Alternatively, pass the keyword parameter ``external_id`` to load from a
    catalog.
    """
    cdef tree.xmlDtd* _c_dtd
    def __init__(self, file=None, *, external_id=None):
        _Validator.__init__(self)
        if file is not None:
            file = _getFSPathOrObject(file)
            if _isString(file):
                file = _encodeFilename(file)
                with self._error_log:
                    orig_loader = _register_document_loader()
                    self._c_dtd = xmlparser.xmlParseDTD(NULL, _xcstr(file))
                    _reset_document_loader(orig_loader)
            elif hasattr(file, 'read'):
                orig_loader = _register_document_loader()
                self._c_dtd = _parseDtdFromFilelike(file)
                _reset_document_loader(orig_loader)
            else:
                raise DTDParseError, "file must be a filename, file-like or path-like object"
        elif external_id is not None:
            external_id_utf = _utf8(external_id)
            with self._error_log:
                orig_loader = _register_document_loader()
                self._c_dtd = xmlparser.xmlParseDTD(<const_xmlChar*>external_id_utf, NULL)
                _reset_document_loader(orig_loader)
        else:
            raise DTDParseError, "either filename or external ID required"

        if self._c_dtd is NULL:
            raise DTDParseError(
                self._error_log._buildExceptionMessage("error parsing DTD"),
                self._error_log)

    @property
    def name(self):
       if self._c_dtd is NULL:
           return None
       return funicodeOrNone(self._c_dtd.name)

    @property
    def external_id(self):
       if self._c_dtd is NULL:
           return None
       return funicodeOrNone(self._c_dtd.ExternalID)

    @property
    def system_url(self):
       if self._c_dtd is NULL:
           return None
       return funicodeOrNone(self._c_dtd.SystemID)

    def iterelements(self):
        cdef tree.xmlNode *c_node = self._c_dtd.children if self._c_dtd is not NULL else NULL
        while c_node is not NULL:
            if c_node.type == tree.XML_ELEMENT_DECL:
                node = _DTDElementDecl()
                node._dtd = self
                node._c_node = <tree.xmlElement*>c_node
                yield node
            c_node = c_node.next

    def elements(self):
        return list(self.iterelements())

    def iterentities(self):
        cdef tree.xmlNode *c_node = self._c_dtd.children if self._c_dtd is not NULL else NULL
        while c_node is not NULL:
            if c_node.type == tree.XML_ENTITY_DECL:
                node = _DTDEntityDecl()
                node._dtd = self
                node._c_node = <tree.xmlEntity*>c_node
                yield node
            c_node = c_node.next

    def entities(self):
        return list(self.iterentities())

    def __dealloc__(self):
        tree.xmlFreeDtd(self._c_dtd)

    def __call__(self, etree):
        """__call__(self, etree)

        Validate doc using the DTD.

        Returns true if the document is valid, false if not.
        """
        cdef _Document doc
        cdef _Element root_node
        cdef xmlDoc* c_doc
        cdef dtdvalid.xmlValidCtxt* valid_ctxt
        cdef int ret = -1

        assert self._c_dtd is not NULL, "DTD not initialised"
        doc = _documentOrRaise(etree)
        root_node = _rootNodeOrRaise(etree)

        valid_ctxt = dtdvalid.xmlNewValidCtxt()
        if valid_ctxt is NULL:
            raise DTDError("Failed to create validation context")

        # work around error reporting bug in libxml2 <= 2.9.1 (and later?)
        # https://bugzilla.gnome.org/show_bug.cgi?id=724903
        valid_ctxt.error = <dtdvalid.xmlValidityErrorFunc>_nullGenericErrorFunc
        valid_ctxt.userData = NULL

        try:
            with self._error_log:
                c_doc = _fakeRootDoc(doc._c_doc, root_node._c_node)
                ret = dtdvalid.xmlValidateDtd(valid_ctxt, c_doc, self._c_dtd)
                _destroyFakeDoc(doc._c_doc, c_doc)
        finally:
            dtdvalid.xmlFreeValidCtxt(valid_ctxt)

        if ret == -1:
            raise DTDValidateError("Internal error in DTD validation",
                                   self._error_log)
        return ret == 1


cdef tree.xmlDtd* _parseDtdFromFilelike(file) except NULL:
    cdef _ExceptionContext exc_context
    cdef _FileReaderContext dtd_parser
    cdef _ErrorLog error_log
    cdef tree.xmlDtd* c_dtd = NULL
    exc_context = _ExceptionContext()
    dtd_parser = _FileReaderContext(file, exc_context, None)
    error_log = _ErrorLog()

    with error_log:
        c_dtd = dtd_parser._readDtd()

    exc_context._raise_if_stored()
    if c_dtd is NULL:
        raise DTDParseError("error parsing DTD", error_log)
    return c_dtd

cdef DTD _dtdFactory(tree.xmlDtd* c_dtd):
    # do not run through DTD.__init__()!
    cdef DTD dtd
    if c_dtd is NULL:
        return None
    dtd = DTD.__new__(DTD)
    dtd._c_dtd = _copyDtd(c_dtd)
    _Validator.__init__(dtd)
    return dtd


cdef tree.xmlDtd* _copyDtd(tree.xmlDtd* c_orig_dtd) except NULL:
    """
    Copy a DTD.  libxml2 (currently) fails to set up the element->attributes
    links when copying DTDs, so we have to rebuild them here.
    """
    c_dtd = tree.xmlCopyDtd(c_orig_dtd)
    if not c_dtd:
        raise MemoryError
    cdef tree.xmlNode* c_node = c_dtd.children
    while c_node:
        if c_node.type == tree.XML_ATTRIBUTE_DECL:
            _linkDtdAttribute(c_dtd, <tree.xmlAttribute*>c_node)
        c_node = c_node.next
    return c_dtd


cdef void _linkDtdAttribute(tree.xmlDtd* c_dtd, tree.xmlAttribute* c_attr) noexcept:
    """
    Create the link to the DTD attribute declaration from the corresponding
    element declaration.
    """
    c_elem = dtdvalid.xmlGetDtdElementDesc(c_dtd, c_attr.elem)
    if not c_elem:
        # no such element? something is wrong with the DTD ...
        return
    c_pos = c_elem.attributes
    if not c_pos:
        c_elem.attributes = c_attr
        c_attr.nexth = NULL
        return
    # libxml2 keeps namespace declarations first, and we need to make
    # sure we don't re-insert attributes that are already there
    if _isDtdNsDecl(c_attr):
        if not _isDtdNsDecl(c_pos):
            c_elem.attributes = c_attr
            c_attr.nexth = c_pos
            return
        while c_pos != c_attr and c_pos.nexth and _isDtdNsDecl(c_pos.nexth):
            c_pos = c_pos.nexth
    else:
        # append at end
        while c_pos != c_attr and c_pos.nexth:
            c_pos = c_pos.nexth
    if c_pos == c_attr:
        return
    c_attr.nexth = c_pos.nexth
    c_pos.nexth = c_attr


cdef bint _isDtdNsDecl(tree.xmlAttribute* c_attr) noexcept:
    if cstring_h.strcmp(<const_char*>c_attr.name, "xmlns") == 0:
        return True
    if (c_attr.prefix is not NULL and
            cstring_h.strcmp(<const_char*>c_attr.prefix, "xmlns") == 0):
        return True
    return False
