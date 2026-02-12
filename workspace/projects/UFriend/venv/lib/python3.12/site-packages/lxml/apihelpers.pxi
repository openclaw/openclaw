# Private/public helper functions for API functions

from lxml.includes cimport uri


cdef void displayNode(xmlNode* c_node, indent) noexcept:
    # to help with debugging
    cdef xmlNode* c_child
    try:
        print(indent * ' ', <long>c_node)
        c_child = c_node.children
        while c_child is not NULL:
            displayNode(c_child, indent + 1)
            c_child = c_child.next
    finally:
        return  # swallow any exceptions

cdef inline bint _isHtmlDocument(_Element element) except -1:
    cdef xmlNode* c_node = element._c_node
    return (
        c_node is not NULL and c_node.doc is not NULL and
        c_node.doc.properties & tree.XML_DOC_HTML != 0
    )

cdef inline int _assertValidNode(_Element element) except -1:
    assert element._c_node is not NULL, "invalid Element proxy at %s" % id(element)

cdef inline int _assertValidDoc(_Document doc) except -1:
    assert doc._c_doc is not NULL, "invalid Document proxy at %s" % id(doc)

cdef _Document _documentOrRaise(object input):
    """Call this to get the document of a _Document, _ElementTree or _Element
    object, or to raise an exception if it can't be determined.

    Should be used in all API functions for consistency.
    """
    cdef _Document doc
    if isinstance(input, _ElementTree):
        if (<_ElementTree>input)._context_node is not None:
            doc = (<_ElementTree>input)._context_node._doc
        else:
            doc = None
    elif isinstance(input, _Element):
        doc = (<_Element>input)._doc
    elif isinstance(input, _Document):
        doc = <_Document>input
    else:
        raise TypeError, f"Invalid input object: {python._fqtypename(input).decode('utf8')}"
    if doc is None:
        raise ValueError, f"Input object has no document: {python._fqtypename(input).decode('utf8')}"
    _assertValidDoc(doc)
    return doc

cdef _Element _rootNodeOrRaise(object input):
    """Call this to get the root node of a _Document, _ElementTree or
     _Element object, or to raise an exception if it can't be determined.

    Should be used in all API functions for consistency.
     """
    cdef _Element node
    if isinstance(input, _ElementTree):
        node = (<_ElementTree>input)._context_node
    elif isinstance(input, _Element):
        node = <_Element>input
    elif isinstance(input, _Document):
        node = (<_Document>input).getroot()
    else:
        raise TypeError, f"Invalid input object: {python._fqtypename(input).decode('utf8')}"
    if (node is None or not node._c_node or
            node._c_node.type != tree.XML_ELEMENT_NODE):
        raise ValueError, f"Input object is not an XML element: {python._fqtypename(input).decode('utf8')}"
    _assertValidNode(node)
    return node

cdef bint _isAncestorOrSame(xmlNode* c_ancestor, xmlNode* c_node) noexcept:
    while c_node:
        if c_node is c_ancestor:
            return True
        c_node = c_node.parent
    return False

cdef _Element _makeElement(tag, xmlDoc* c_doc, _Document doc,
                           _BaseParser parser, text, tail, attrib, nsmap,
                           dict extra_attrs):
    """Create a new element and initialize text content, namespaces and
    attributes.

    This helper function will reuse as much of the existing document as
    possible:

    If 'parser' is None, the parser will be inherited from 'doc' or the
    default parser will be used.

    If 'doc' is None, 'c_doc' is used to create a new _Document and the new
    element is made its root node.

    If 'c_doc' is also NULL, a new xmlDoc will be created.
    """
    cdef xmlNode* c_node
    if doc is not None:
        c_doc = doc._c_doc
    ns_utf, name_utf = _getNsTag(tag)
    if parser is not None and parser._for_html:
        _htmlTagValidOrRaise(name_utf)
        if c_doc is NULL:
            c_doc = _newHTMLDoc()
    else:
        _tagValidOrRaise(name_utf)
        if c_doc is NULL:
            c_doc = _newXMLDoc()
    c_node = _createElement(c_doc, name_utf)
    if c_node is NULL:
        if doc is None and c_doc is not NULL:
            tree.xmlFreeDoc(c_doc)
        raise MemoryError()
    try:
        if doc is None:
            tree.xmlDocSetRootElement(c_doc, c_node)
            doc = _documentFactory(c_doc, parser)
        if text is not None:
            _setNodeText(c_node, text)
        if tail is not None:
            _setTailText(c_node, tail)
        # add namespaces to node if necessary
        _setNodeNamespaces(c_node, doc, ns_utf, nsmap)
        _initNodeAttributes(c_node, doc, attrib, extra_attrs)
        return _elementFactory(doc, c_node)
    except:
        # free allocated c_node/c_doc unless Python does it for us
        if c_node.doc is not c_doc:
            # node not yet in document => will not be freed by document
            if tail is not None:
                _removeText(c_node.next) # tail
            tree.xmlFreeNode(c_node)
        if doc is None:
            # c_doc will not be freed by doc
            tree.xmlFreeDoc(c_doc)
        raise

cdef int _initNewElement(_Element element, bint is_html, name_utf, ns_utf,
                         _BaseParser parser, attrib, nsmap, dict extra_attrs) except -1:
    """Initialise a new Element object.

    This is used when users instantiate a Python Element subclass
    directly, without it being mapped to an existing XML node.
    """
    cdef xmlDoc* c_doc
    cdef xmlNode* c_node
    cdef _Document doc
    if is_html:
        _htmlTagValidOrRaise(name_utf)
        c_doc = _newHTMLDoc()
    else:
        _tagValidOrRaise(name_utf)
        c_doc = _newXMLDoc()
    c_node = _createElement(c_doc, name_utf)
    if c_node is NULL:
        if c_doc is not NULL:
            tree.xmlFreeDoc(c_doc)
        raise MemoryError()
    tree.xmlDocSetRootElement(c_doc, c_node)
    doc = _documentFactory(c_doc, parser)
    # add namespaces to node if necessary
    _setNodeNamespaces(c_node, doc, ns_utf, nsmap)
    _initNodeAttributes(c_node, doc, attrib, extra_attrs)
    _registerProxy(element, doc, c_node)
    element._init()
    return 0

cdef _Element _makeSubElement(_Element parent, tag, text, tail,
                              attrib, nsmap, dict extra_attrs):
    """Create a new child element and initialize text content, namespaces and
    attributes.
    """
    cdef xmlNode* c_node
    cdef xmlDoc* c_doc
    if parent is None or parent._doc is None:
        return None
    _assertValidNode(parent)
    ns_utf, name_utf = _getNsTag(tag)
    c_doc = parent._doc._c_doc

    if parent._doc._parser is not None and parent._doc._parser._for_html:
        _htmlTagValidOrRaise(name_utf)
    else:
        _tagValidOrRaise(name_utf)

    c_node = _createElement(c_doc, name_utf)
    if c_node is NULL:
        raise MemoryError()
    tree.xmlAddChild(parent._c_node, c_node)

    try:
        if text is not None:
            _setNodeText(c_node, text)
        if tail is not None:
            _setTailText(c_node, tail)

        # add namespaces to node if necessary
        _setNodeNamespaces(c_node, parent._doc, ns_utf, nsmap)
        _initNodeAttributes(c_node, parent._doc, attrib, extra_attrs)
        return _elementFactory(parent._doc, c_node)
    except:
        # make sure we clean up in case of an error
        _removeNode(parent._doc, c_node)
        raise


cdef int _setNodeNamespaces(xmlNode* c_node, _Document doc,
                            object node_ns_utf, object nsmap) except -1:
    """Lookup current namespace prefixes, then set namespace structure for
    node (if 'node_ns_utf' was provided) and register new ns-prefix mappings.

    'node_ns_utf' should only be passed for a newly created node.
    """
    cdef xmlNs* c_ns
    cdef list nsdefs

    if nsmap:
        for prefix, href in _iter_nsmap(nsmap):
            href_utf = _utf8(href)
            _uriValidOrRaise(href_utf)
            c_href = _xcstr(href_utf)
            if prefix is not None:
                prefix_utf = _utf8(prefix)
                _prefixValidOrRaise(prefix_utf)
                c_prefix = _xcstr(prefix_utf)
            else:
                c_prefix = <const_xmlChar*>NULL
            # add namespace with prefix if it is not already known
            c_ns = tree.xmlSearchNs(doc._c_doc, c_node, c_prefix)
            if c_ns is NULL or \
                    c_ns.href is NULL or \
                    tree.xmlStrcmp(c_ns.href, c_href) != 0:
                c_ns = tree.xmlNewNs(c_node, c_href, c_prefix)
            if href_utf == node_ns_utf:
                tree.xmlSetNs(c_node, c_ns)
                node_ns_utf = None

    if node_ns_utf is not None:
        _uriValidOrRaise(node_ns_utf)
        doc._setNodeNs(c_node, _xcstr(node_ns_utf))
    return 0


cdef dict _build_nsmap(xmlNode* c_node):
    """
    Namespace prefix->URI mapping known in the context of this Element.
    This includes all namespace declarations of the parents.
    """
    cdef xmlNs* c_ns
    nsmap = {}
    while c_node is not NULL and c_node.type == tree.XML_ELEMENT_NODE:
        c_ns = c_node.nsDef
        while c_ns is not NULL:
            if c_ns.prefix or c_ns.href:
                prefix = funicodeOrNone(c_ns.prefix)
                if prefix not in nsmap:
                    nsmap[prefix] = funicodeOrNone(c_ns.href)
            c_ns = c_ns.next
        c_node = c_node.parent
    return nsmap


cdef _iter_nsmap(nsmap):
    """
    Create a reproducibly ordered iterable from an nsmap mapping.
    Tries to preserve an existing order and sorts if it assumes no order.

    The difference to _iter_attrib() is that None doesn't sort with strings
    in Py3.x.
    """
    if isinstance(nsmap, dict):
        # dicts are insertion-ordered in Py3.6+ => keep the user provided order.
        return nsmap.items()
    if len(nsmap) <= 1:
        return nsmap.items()
    # nsmap will usually be a plain unordered dict => avoid type checking overhead
    if type(nsmap) is not dict and isinstance(nsmap, OrderedDict):
        return nsmap.items()  # keep existing order
    if None not in nsmap:
        return sorted(nsmap.items())

    # Move the default namespace to the end.  This makes sure libxml2
    # prefers a prefix if the ns is defined redundantly on the same
    # element.  That way, users can work around a problem themselves
    # where default namespace attributes on non-default namespaced
    # elements serialise without prefix (i.e. into the non-default
    # namespace).
    default_ns = nsmap[None]
    nsdefs = [(k, v) for k, v in nsmap.items() if k is not None]
    nsdefs.sort()
    nsdefs.append((None, default_ns))
    return nsdefs


cdef _iter_attrib(attrib):
    """
    Create a reproducibly ordered iterable from an attrib mapping.
    Tries to preserve an existing order and sorts if it assumes no order.
    """
    # dicts are insertion-ordered in Py3.6+ => keep the user provided order.
    if isinstance(attrib, (dict, _Attrib, OrderedDict)):
        return attrib.items()
    # assume it's an unordered mapping of some kind
    return sorted(attrib.items())


cdef _initNodeAttributes(xmlNode* c_node, _Document doc, attrib, dict extra):
    """Initialise the attributes of an element node.
    """
    cdef bint is_html
    cdef xmlNs* c_ns
    if attrib is not None and not hasattr(attrib, 'items'):
        raise TypeError, f"Invalid attribute dictionary: {python._fqtypename(attrib).decode('utf8')}"
    if not attrib and not extra:
        return  # nothing to do
    is_html = doc._parser._for_html
    seen = set()
    if extra:
        for name, value in extra.items():
            _addAttributeToNode(c_node, doc, is_html, name, value, seen)
    if attrib:
        for name, value in _iter_attrib(attrib):
            _addAttributeToNode(c_node, doc, is_html, name, value, seen)


cdef int _addAttributeToNode(xmlNode* c_node, _Document doc, bint is_html,
                             name, value, set seen_tags) except -1:
    ns_utf, name_utf = tag = _getNsTag(name)
    if tag in seen_tags:
        return 0
    seen_tags.add(tag)
    if not is_html:
        _attributeValidOrRaise(name_utf)
    value_utf = _utf8(value)
    if ns_utf is None:
        tree.xmlNewProp(c_node, _xcstr(name_utf), _xcstr(value_utf))
    else:
        _uriValidOrRaise(ns_utf)
        c_ns = doc._findOrBuildNodeNs(c_node, _xcstr(ns_utf), NULL, 1)
        tree.xmlNewNsProp(c_node, c_ns,
                          _xcstr(name_utf), _xcstr(value_utf))
    return 0


ctypedef struct _ns_node_ref:
    xmlNs* ns
    xmlNode* node


cdef int _collectNsDefs(xmlNode* c_element, _ns_node_ref **_c_ns_list,
                        size_t *_c_ns_list_len, size_t *_c_ns_list_size) except -1:
    c_ns_list = _c_ns_list[0]
    cdef size_t c_ns_list_len = _c_ns_list_len[0]
    cdef size_t c_ns_list_size = _c_ns_list_size[0]

    c_nsdef = c_element.nsDef
    while c_nsdef is not NULL:
        if c_ns_list_len >= c_ns_list_size:
            if c_ns_list is NULL:
                c_ns_list_size = 20
            else:
                c_ns_list_size *= 2
            c_nsref_ptr = <_ns_node_ref*> python.lxml_realloc(
                c_ns_list, c_ns_list_size, sizeof(_ns_node_ref))
            if c_nsref_ptr is NULL:
                if c_ns_list is not NULL:
                    python.lxml_free(c_ns_list)
                    _c_ns_list[0] = NULL
                raise MemoryError()
            c_ns_list = c_nsref_ptr

        c_ns_list[c_ns_list_len] = _ns_node_ref(c_nsdef, c_element)
        c_ns_list_len += 1
        c_nsdef = c_nsdef.next

    _c_ns_list_size[0] = c_ns_list_size
    _c_ns_list_len[0] = c_ns_list_len
    _c_ns_list[0] = c_ns_list


cdef int _removeUnusedNamespaceDeclarations(xmlNode* c_element, set prefixes_to_keep) except -1:
    """Remove any namespace declarations from a subtree that are not used by
    any of its elements (or attributes).

    If a 'prefixes_to_keep' is provided, it must be a set of prefixes.
    Any corresponding namespace mappings will not be removed as part of the cleanup.
    """
    cdef xmlNode* c_node
    cdef _ns_node_ref* c_ns_list = NULL
    cdef size_t c_ns_list_size = 0
    cdef size_t c_ns_list_len = 0
    cdef size_t i

    if c_element.parent and c_element.parent.type == tree.XML_DOCUMENT_NODE:
        # include declarations on the document node
        _collectNsDefs(c_element.parent, &c_ns_list, &c_ns_list_len, &c_ns_list_size)

    tree.BEGIN_FOR_EACH_ELEMENT_FROM(c_element, c_element, 1)
    # collect all new namespace declarations into the ns list
    if c_element.nsDef:
        _collectNsDefs(c_element, &c_ns_list, &c_ns_list_len, &c_ns_list_size)

    # remove all namespace declarations from the list that are referenced
    if c_ns_list_len and c_element.type == tree.XML_ELEMENT_NODE:
        c_node = c_element
        while c_node and c_ns_list_len:
            if c_node.ns:
                for i in range(c_ns_list_len):
                    if c_node.ns is c_ns_list[i].ns:
                        c_ns_list_len -= 1
                        c_ns_list[i] = c_ns_list[c_ns_list_len]
                        #c_ns_list[c_ns_list_len] = _ns_node_ref(NULL, NULL)
                        break
            if c_node is c_element:
                # continue with attributes
                c_node = <xmlNode*>c_element.properties
            else:
                c_node = c_node.next
    tree.END_FOR_EACH_ELEMENT_FROM(c_element)

    if c_ns_list is NULL:
        return 0

    # free all namespace declarations that remained in the list,
    # except for those we should keep explicitly
    cdef xmlNs* c_nsdef
    for i in range(c_ns_list_len):
        if prefixes_to_keep is not None:
            if c_ns_list[i].ns.prefix and c_ns_list[i].ns.prefix in prefixes_to_keep:
                continue
        c_node = c_ns_list[i].node
        c_nsdef = c_node.nsDef
        if c_nsdef is c_ns_list[i].ns:
            c_node.nsDef = c_node.nsDef.next
        else:
            while c_nsdef.next is not c_ns_list[i].ns:
                c_nsdef = c_nsdef.next
            c_nsdef.next = c_nsdef.next.next
        tree.xmlFreeNs(c_ns_list[i].ns)

    if c_ns_list is not NULL:
        python.lxml_free(c_ns_list)
    return 0

cdef xmlNs* _searchNsByHref(xmlNode* c_node, const_xmlChar* c_href, bint is_attribute) noexcept:
    """Search a namespace declaration that covers a node (element or
    attribute).

    For attributes, try to find a prefixed namespace declaration
    instead of the default namespaces.  This helps in supporting
    round-trips for attributes on elements with a different namespace.
    """
    cdef xmlNs* c_ns
    cdef xmlNs* c_default_ns = NULL
    cdef xmlNode* c_element
    if c_href is NULL or c_node is NULL or c_node.type == tree.XML_ENTITY_REF_NODE:
        return NULL
    if tree.xmlStrcmp(c_href, tree.XML_XML_NAMESPACE) == 0:
        # no special cases here, let libxml2 handle this
        return tree.xmlSearchNsByHref(c_node.doc, c_node, c_href)
    if c_node.type == tree.XML_ATTRIBUTE_NODE:
        is_attribute = 1
    while c_node is not NULL and c_node.type != tree.XML_ELEMENT_NODE:
        c_node = c_node.parent
    c_element = c_node
    while c_node is not NULL:
        if c_node.type == tree.XML_ELEMENT_NODE:
            c_ns = c_node.nsDef
            while c_ns is not NULL:
                if c_ns.href is not NULL and tree.xmlStrcmp(c_href, c_ns.href) == 0:
                    if c_ns.prefix is NULL and is_attribute:
                        # for attributes, continue searching a named
                        # prefix, but keep the first default namespace
                        # declaration that we found
                        if c_default_ns is NULL:
                            c_default_ns = c_ns
                    elif tree.xmlSearchNs(
                        c_element.doc, c_element, c_ns.prefix) is c_ns:
                        # start node is in namespace scope => found!
                        return c_ns
                c_ns = c_ns.next
            if c_node is not c_element and c_node.ns is not NULL:
                # optimise: the node may have the namespace itself
                c_ns = c_node.ns
                if c_ns.href is not NULL and tree.xmlStrcmp(c_href, c_ns.href) == 0:
                    if c_ns.prefix is NULL and is_attribute:
                        # for attributes, continue searching a named
                        # prefix, but keep the first default namespace
                        # declaration that we found
                        if c_default_ns is NULL:
                            c_default_ns = c_ns
                    elif tree.xmlSearchNs(
                        c_element.doc, c_element, c_ns.prefix) is c_ns:
                        # start node is in namespace scope => found!
                        return c_ns
        c_node = c_node.parent
    # nothing found => use a matching default namespace or fail
    if c_default_ns is not NULL:
        if tree.xmlSearchNs(c_element.doc, c_element, NULL) is c_default_ns:
            return c_default_ns
    return NULL

cdef int _replaceNodeByChildren(_Document doc, xmlNode* c_node) except -1:
    # NOTE: this does not deallocate the node, just unlink it!
    cdef xmlNode* c_parent
    cdef xmlNode* c_child
    if c_node.children is NULL:
        tree.xmlUnlinkNode(c_node)
        return 0

    c_parent = c_node.parent
    # fix parent links of children
    c_child = c_node.children
    while c_child is not NULL:
        c_child.parent = c_parent
        c_child = c_child.next

    # fix namespace references of children if their parent's namespace
    # declarations get lost
    if c_node.nsDef is not NULL:
        c_child = c_node.children
        while c_child is not NULL:
            moveNodeToDocument(doc, doc._c_doc, c_child)
            c_child = c_child.next

    # fix sibling links to/from child slice
    if c_node.prev is NULL:
        c_parent.children = c_node.children
    else:
        c_node.prev.next = c_node.children
        c_node.children.prev = c_node.prev
    if c_node.next is NULL:
        c_parent.last = c_node.last
    else:
        c_node.next.prev = c_node.last
        c_node.last.next = c_node.next

    # unlink c_node
    c_node.children = c_node.last = NULL
    c_node.parent = c_node.next = c_node.prev = NULL
    return 0

cdef unicode _attributeValue(xmlNode* c_element, xmlAttr* c_attrib_node):
    c_href = _getNs(<xmlNode*>c_attrib_node)
    value = tree.xmlGetNsProp(c_element, c_attrib_node.name, c_href)
    try:
        result = funicode(value)
    finally:
        tree.xmlFree(value)
    return result

cdef unicode _attributeValueFromNsName(xmlNode* c_element,
                                       const_xmlChar* c_href, const_xmlChar* c_name):
    c_result = tree.xmlGetNsProp(c_element, c_name, c_href)
    if c_result is NULL:
        return None
    try:
        result = funicode(c_result)
    finally:
        tree.xmlFree(c_result)
    return result

cdef object _getNodeAttributeValue(xmlNode* c_node, key, default):
    ns, tag = _getNsTag(key)
    c_href = <const_xmlChar*>NULL if ns is None else _xcstr(ns)
    c_result = tree.xmlGetNsProp(c_node, _xcstr(tag), c_href)
    if c_result is NULL:
        # XXX free namespace that is not in use..?
        return default
    try:
        result = funicode(c_result)
    finally:
        tree.xmlFree(c_result)
    return result

cdef inline object _getAttributeValue(_Element element, key, default):
    return _getNodeAttributeValue(element._c_node, key, default)

cdef int _setAttributeValue(_Element element, key, value) except -1:
    cdef const_xmlChar* c_value
    cdef xmlNs* c_ns
    ns, tag = _getNsTag(key)
    is_html = element._doc._parser._for_html
    if not is_html:
        _attributeValidOrRaise(tag)
    c_tag = _xcstr(tag)
    if value is None and is_html:
        c_value = NULL
    else:
        if isinstance(value, QName):
            value = _resolveQNameText(element, value)
        else:
            value = _utf8(value)
        c_value = _xcstr(value)
    if ns is None:
        c_ns = NULL
    else:
        c_ns = element._doc._findOrBuildNodeNs(element._c_node, _xcstr(ns), NULL, 1)
    tree.xmlSetNsProp(element._c_node, c_ns, c_tag, c_value)
    return 0

cdef int _delAttribute(_Element element, key) except -1:
    ns, tag = _getNsTag(key)
    c_href = <const_xmlChar*>NULL if ns is None else _xcstr(ns)
    if _delAttributeFromNsName(element._c_node, c_href, _xcstr(tag)):
        raise KeyError, key
    return 0

cdef int _delAttributeFromNsName(xmlNode* c_node, const_xmlChar* c_href, const_xmlChar* c_name) noexcept:
    c_attr = tree.xmlHasNsProp(c_node, c_name, c_href)
    if c_attr is NULL:
        # XXX free namespace that is not in use..?
        return -1
    tree.xmlRemoveProp(c_attr)
    return 0

cdef list _collectAttributes(xmlNode* c_node, int collecttype):
    """Collect all attributes of a node in a list.  Depending on collecttype,
    it collects either the name (1), the value (2) or the name-value tuples.
    """
    cdef Py_ssize_t count
    c_attr = c_node.properties
    count = 0
    while c_attr is not NULL:
        if c_attr.type == tree.XML_ATTRIBUTE_NODE:
            count += 1
        c_attr = c_attr.next

    if not count:
        return []

    attributes = [None] * count
    c_attr = c_node.properties
    count = 0
    while c_attr is not NULL:
        if c_attr.type == tree.XML_ATTRIBUTE_NODE:
            if collecttype == 1:
                item = _namespacedName(<xmlNode*>c_attr)
            elif collecttype == 2:
                item = _attributeValue(c_node, c_attr)
            else:
                item = (_namespacedName(<xmlNode*>c_attr),
                        _attributeValue(c_node, c_attr))
            attributes[count] = item
            count += 1
        c_attr = c_attr.next
    return attributes

cdef object __RE_XML_ENCODING = re.compile(
    r'^(<\?xml[^>]+)\s+encoding\s*=\s*["\'][^"\']*["\'](\s*\?>|)', re.U)

cdef object __REPLACE_XML_ENCODING = __RE_XML_ENCODING.sub
cdef object __HAS_XML_ENCODING = __RE_XML_ENCODING.match

cdef object _stripEncodingDeclaration(object xml_string):
    # this is a hack to remove the XML encoding declaration from unicode
    return __REPLACE_XML_ENCODING(r'\g<1>\g<2>', xml_string)

cdef bint _hasEncodingDeclaration(object xml_string) except -1:
    # check if a (unicode) string has an XML encoding declaration
    return __HAS_XML_ENCODING(xml_string) is not None

cdef inline bint _hasText(xmlNode* c_node) noexcept:
    return c_node is not NULL and _textNodeOrSkip(c_node.children) is not NULL

cdef inline bint _hasTail(xmlNode* c_node) noexcept:
    return c_node is not NULL and _textNodeOrSkip(c_node.next) is not NULL

cdef inline bint _hasNonWhitespaceTail(xmlNode* c_node) except -1:
    return _hasNonWhitespaceText(c_node, tail=True)

cdef bint _hasNonWhitespaceText(xmlNode* c_node, bint tail=False) except -1:
    c_text_node = c_node and _textNodeOrSkip(c_node.next if tail else c_node.children)
    if c_text_node is NULL:
        return False
    while c_text_node is not NULL:
        if c_text_node.content[0] != c'\0' and not _collectText(c_text_node).isspace():
            return True
        c_text_node = _textNodeOrSkip(c_text_node.next)
    return False

cdef unicode _collectText(xmlNode* c_node):
    """Collect all text nodes and return them as a unicode string.

    Start collecting at c_node.

    If there was no text to collect, return None
    """
    cdef Py_ssize_t scount
    cdef xmlChar* c_text
    cdef xmlNode* c_node_cur
    # check for multiple text nodes
    scount = 0
    c_text = NULL
    c_node_cur = c_node = _textNodeOrSkip(c_node)
    while c_node_cur is not NULL:
        if c_node_cur.content[0] != c'\0':
            c_text = c_node_cur.content
        scount += 1
        c_node_cur = _textNodeOrSkip(c_node_cur.next)

    # handle two most common cases first
    if c_text is NULL:
        return '' if scount > 0 else None
    if scount == 1:
        return funicode(c_text)

    # the rest is not performance critical anymore
    result = b''
    while c_node is not NULL:
        result += <unsigned char*>c_node.content
        c_node = _textNodeOrSkip(c_node.next)
    return funicode(<const_xmlChar*><unsigned char*>result)

cdef void _removeText(xmlNode* c_node) noexcept:
    """Remove all text nodes.

    Start removing at c_node.
    """
    cdef xmlNode* c_next
    c_node = _textNodeOrSkip(c_node)
    while c_node is not NULL:
        c_next = _textNodeOrSkip(c_node.next)
        tree.xmlUnlinkNode(c_node)
        tree.xmlFreeNode(c_node)
        c_node = c_next

cdef xmlNode* _createTextNode(xmlDoc* doc, value) except NULL:
    cdef xmlNode* c_text_node
    if isinstance(value, CDATA):
        c_text_node = tree.xmlNewCDataBlock(
            doc, _xcstr((<CDATA>value)._utf8_data),
            python.PyBytes_GET_SIZE((<CDATA>value)._utf8_data))
    else:
        text = _utf8(value)
        c_text_node = tree.xmlNewDocText(doc, _xcstr(text))
    if not c_text_node:
        raise MemoryError()
    return c_text_node

cdef int _setNodeText(xmlNode* c_node, value) except -1:
    # remove all text nodes at the start first
    _removeText(c_node.children)
    if value is None:
        return 0
    # now add new text node with value at start
    c_text_node = _createTextNode(c_node.doc, value)
    if c_node.children is NULL:
        tree.xmlAddChild(c_node, c_text_node)
    else:
        tree.xmlAddPrevSibling(c_node.children, c_text_node)
    return 0

cdef int _setTailText(xmlNode* c_node, value) except -1:
    # remove all text nodes at the start first
    _removeText(c_node.next)
    if value is None:
        return 0
    # now append new text node with value
    c_text_node = _createTextNode(c_node.doc, value)
    tree.xmlAddNextSibling(c_node, c_text_node)
    return 0

cdef bytes _resolveQNameText(_Element element, value):
    cdef xmlNs* c_ns
    ns, tag = _getNsTag(value)
    if ns is None:
        return tag
    else:
        c_ns = element._doc._findOrBuildNodeNs(
            element._c_node, _xcstr(ns), NULL, 0)
        return python.PyBytes_FromFormat('%s:%s', c_ns.prefix, _cstr(tag))

cdef inline bint _hasChild(xmlNode* c_node) noexcept:
    return c_node is not NULL and _findChildForwards(c_node, 0) is not NULL

cdef inline Py_ssize_t _countElements(xmlNode* c_node) noexcept:
    "Counts the elements within the following siblings and the node itself."
    cdef Py_ssize_t count
    count = 0
    while c_node is not NULL:
        if _isElement(c_node):
            count += 1
        c_node = c_node.next
    return count

cdef int _findChildSlice(
    slice sliceobject, xmlNode* c_parent,
    xmlNode** c_start_node, Py_ssize_t* c_step, Py_ssize_t* c_length) except -1:
    """Resolve a children slice.

    Returns the start node, step size and the slice length in the
    pointer arguments.
    """
    cdef Py_ssize_t start = 0, stop = 0, childcount
    childcount = _countElements(c_parent.children)
    if childcount == 0:
        c_start_node[0] = NULL
        c_length[0] = 0
        if sliceobject.step is None:
            c_step[0] = 1
        else:
            python._PyEval_SliceIndex(sliceobject.step, c_step)
        return 0
    python.PySlice_GetIndicesEx(
        sliceobject, childcount, &start, &stop, c_step, c_length)
    if start > childcount // 2:
        c_start_node[0] = _findChildBackwards(c_parent, childcount - start - 1)
    else:
        c_start_node[0] = _findChild(c_parent, start)
    return 0

cdef bint _isFullSlice(slice sliceobject) except -1:
    """Conservative guess if this slice is a full slice as in ``s[:]``.
    """
    cdef Py_ssize_t step = 0
    if sliceobject is None:
        return 0
    if sliceobject.start is None and \
            sliceobject.stop is None:
        if sliceobject.step is None:
            return 1
        python._PyEval_SliceIndex(sliceobject.step, &step)
        if step == 1:
            return 1
        return 0
    return 0

cdef _collectChildren(_Element element):
    cdef xmlNode* c_node
    cdef list result = []
    c_node = element._c_node.children
    if c_node is not NULL:
        if not _isElement(c_node):
            c_node = _nextElement(c_node)
        while c_node is not NULL:
            result.append(_elementFactory(element._doc, c_node))
            c_node = _nextElement(c_node)
    return result

cdef inline xmlNode* _findChild(xmlNode* c_node, Py_ssize_t index) noexcept:
    if index < 0:
        return _findChildBackwards(c_node, -index - 1)
    else:
        return _findChildForwards(c_node, index)

cdef inline xmlNode* _findChildForwards(xmlNode* c_node, Py_ssize_t index) noexcept:
    """Return child element of c_node with index, or return NULL if not found.
    """
    cdef xmlNode* c_child
    cdef Py_ssize_t c
    c_child = c_node.children
    c = 0
    while c_child is not NULL:
        if _isElement(c_child):
            if c == index:
                return c_child
            c += 1
        c_child = c_child.next
    return NULL

cdef inline xmlNode* _findChildBackwards(xmlNode* c_node, Py_ssize_t index) noexcept:
    """Return child element of c_node with index, or return NULL if not found.
    Search from the end.
    """
    cdef xmlNode* c_child
    cdef Py_ssize_t c
    c_child = c_node.last
    c = 0
    while c_child is not NULL:
        if _isElement(c_child):
            if c == index:
                return c_child
            c += 1
        c_child = c_child.prev
    return NULL

cdef inline xmlNode* _textNodeOrSkip(xmlNode* c_node) noexcept nogil:
    """Return the node if it's a text node.  Skip over ignorable nodes in a
    series of text nodes.  Return NULL if a non-ignorable node is found.

    This is used to skip over XInclude nodes when collecting adjacent text
    nodes.
    """
    while c_node is not NULL:
        if c_node.type == tree.XML_TEXT_NODE or \
               c_node.type == tree.XML_CDATA_SECTION_NODE:
            return c_node
        elif c_node.type == tree.XML_XINCLUDE_START or \
                 c_node.type == tree.XML_XINCLUDE_END:
            c_node = c_node.next
        else:
            return NULL
    return NULL

cdef inline xmlNode* _nextElement(xmlNode* c_node) noexcept:
    """Given a node, find the next sibling that is an element.
    """
    if c_node is NULL:
        return NULL
    c_node = c_node.next
    while c_node is not NULL:
        if _isElement(c_node):
            return c_node
        c_node = c_node.next
    return NULL

cdef inline xmlNode* _previousElement(xmlNode* c_node) noexcept:
    """Given a node, find the next sibling that is an element.
    """
    if c_node is NULL:
        return NULL
    c_node = c_node.prev
    while c_node is not NULL:
        if _isElement(c_node):
            return c_node
        c_node = c_node.prev
    return NULL

cdef inline xmlNode* _parentElement(xmlNode* c_node) noexcept:
    "Given a node, find the parent element."
    if c_node is NULL or not _isElement(c_node):
        return NULL
    c_node = c_node.parent
    if c_node is NULL or not _isElement(c_node):
        return NULL
    return c_node

cdef inline bint _tagMatches(xmlNode* c_node, const_xmlChar* c_href, const_xmlChar* c_name) noexcept:
    """Tests if the node matches namespace URI and tag name.

    A node matches if it matches both c_href and c_name.

    A node matches c_href if any of the following is true:
    * c_href is NULL
    * its namespace is NULL and c_href is the empty string
    * its namespace string equals the c_href string

    A node matches c_name if any of the following is true:
    * c_name is NULL
    * its name string equals the c_name string
    """
    if c_node is NULL:
        return 0
    if c_node.type != tree.XML_ELEMENT_NODE:
        # not an element, only succeed if we match everything
        return c_name is NULL and c_href is NULL
    if c_name is NULL:
        if c_href is NULL:
            # always match
            return 1
        else:
            c_node_href = _getNs(c_node)
            if c_node_href is NULL:
                return c_href[0] == c'\0'
            else:
                return tree.xmlStrcmp(c_node_href, c_href) == 0
    elif c_href is NULL:
        if _getNs(c_node) is not NULL:
            return 0
        return c_node.name == c_name or tree.xmlStrcmp(c_node.name, c_name) == 0
    elif c_node.name == c_name or tree.xmlStrcmp(c_node.name, c_name) == 0:
        c_node_href = _getNs(c_node)
        if c_node_href is NULL:
            return c_href[0] == c'\0'
        else:
            return tree.xmlStrcmp(c_node_href, c_href) == 0
    else:
        return 0

cdef inline bint _tagMatchesExactly(xmlNode* c_node, qname* c_qname) noexcept:
    """Tests if the node matches namespace URI and tag name.

    This differs from _tagMatches() in that it does not consider a
    NULL value in qname.href a wildcard, and that it expects the c_name
    to be taken from the doc dict, i.e. it only compares the names by
    address.

    A node matches if it matches both href and c_name of the qname.

    A node matches c_href if any of the following is true:
    * its namespace is NULL and c_href is the empty string
    * its namespace string equals the c_href string

    A node matches c_name if any of the following is true:
    * c_name is NULL
    * its name string points to the same address (!) as c_name
    """
    return _nsTagMatchesExactly(_getNs(c_node), c_node.name, c_qname)

cdef inline bint _nsTagMatchesExactly(const_xmlChar* c_node_href,
                                      const_xmlChar* c_node_name,
                                      qname* c_qname) noexcept:
    """Tests if name and namespace URI match those of c_qname.

    This differs from _tagMatches() in that it does not consider a
    NULL value in qname.href a wildcard, and that it expects the c_name
    to be taken from the doc dict, i.e. it only compares the names by
    address.

    A node matches if it matches both href and c_name of the qname.

    A node matches c_href if any of the following is true:
    * its namespace is NULL and c_href is the empty string
    * its namespace string equals the c_href string

    A node matches c_name if any of the following is true:
    * c_name is NULL
    * its name string points to the same address (!) as c_name
    """
    cdef char* c_href
    if c_qname.c_name is not NULL and c_qname.c_name is not c_node_name:
        return 0
    if c_qname.href is NULL:
        return 1
    c_href = python.__cstr(c_qname.href)
    if c_href[0] == b'\0':
        return c_node_href is NULL or c_node_href[0] == b'\0'
    elif c_node_href is NULL:
        return 0
    else:
        return tree.xmlStrcmp(<const_xmlChar*>c_href, c_node_href) == 0

cdef Py_ssize_t _mapTagsToQnameMatchArray(xmlDoc* c_doc, list ns_tags,
                                          qname* c_ns_tags, bint force_into_dict) except -1:
    """Map a sequence of (name, namespace) pairs to a qname array for efficient
    matching with _tagMatchesExactly() above.

    Note that each qname struct in the array owns its href byte string object
    if it is not NULL.
    """
    cdef Py_ssize_t count = 0, i, c_tag_len
    cdef bytes ns, tag
    cdef const_xmlChar* c_tag

    for ns, tag in ns_tags:
        if tag is None:
            c_tag = <const_xmlChar*> NULL
        else:
            c_tag_len = len(tag)
            if c_tag_len > limits.INT_MAX:
                # too long, not in the dict => not in the document
                continue
            elif force_into_dict:
                c_tag = tree.xmlDictLookup(c_doc.dict, _xcstr(tag), <int> c_tag_len)
                if c_tag is NULL:
                    # clean up before raising the error
                    for i in xrange(count):
                        cpython.ref.Py_XDECREF(c_ns_tags[i].href)
                    raise MemoryError()
            else:
                c_tag = tree.xmlDictExists(c_doc.dict, _xcstr(tag), <int> c_tag_len)
                if c_tag is NULL:
                    # not in the dict => not in the document
                    continue

        c_ns_tags[count].c_name = c_tag
        if ns is None:
            c_ns_tags[count].href = NULL
        else:
            cpython.ref.Py_INCREF(ns) # keep an owned reference!
            c_ns_tags[count].href = <python.PyObject*>ns
        count += 1
    return count

cdef int _removeNode(_Document doc, xmlNode* c_node) except -1:
    """Unlink and free a node and subnodes if possible.  Otherwise, make sure
    it's self-contained.
    """
    cdef xmlNode* c_next
    c_next = c_node.next
    tree.xmlUnlinkNode(c_node)
    _moveTail(c_next, c_node)
    if not attemptDeallocation(c_node):
        # make namespaces absolute
        moveNodeToDocument(doc, c_node.doc, c_node)
    return 0

cdef int _removeSiblings(xmlNode* c_element, tree.xmlElementType node_type, bint with_tail) except -1:
    cdef xmlNode* c_node
    cdef xmlNode* c_next
    c_node = c_element.next
    while c_node is not NULL:
        c_next = _nextElement(c_node)
        if c_node.type == node_type:
            if with_tail:
                _removeText(c_node.next)
            tree.xmlUnlinkNode(c_node)
            attemptDeallocation(c_node)
        c_node = c_next
    c_node = c_element.prev
    while c_node is not NULL:
        c_next = _previousElement(c_node)
        if c_node.type == node_type:
            if with_tail:
                _removeText(c_node.next)
            tree.xmlUnlinkNode(c_node)
            attemptDeallocation(c_node)
        c_node = c_next
    return 0

cdef void _moveTail(xmlNode* c_tail, xmlNode* c_target) noexcept:
    cdef xmlNode* c_next
    # tail support: look for any text nodes trailing this node and
    # move them too
    c_tail = _textNodeOrSkip(c_tail)
    while c_tail is not NULL:
        c_next = _textNodeOrSkip(c_tail.next)
        c_target = tree.xmlAddNextSibling(c_target, c_tail)
        c_tail = c_next

cdef int _copyTail(xmlNode* c_tail, xmlNode* c_target) except -1:
    cdef xmlNode* c_new_tail
    # tail copying support: look for any text nodes trailing this node and
    # copy it to the target node
    c_tail = _textNodeOrSkip(c_tail)
    while c_tail is not NULL:
        if c_target.doc is not c_tail.doc:
            c_new_tail = tree.xmlDocCopyNode(c_tail, c_target.doc, 0)
        else:
            c_new_tail = tree.xmlCopyNode(c_tail, 0)
        if c_new_tail is NULL:
            raise MemoryError()
        c_target = tree.xmlAddNextSibling(c_target, c_new_tail)
        c_tail = _textNodeOrSkip(c_tail.next)
    return 0

cdef int _copyNonElementSiblings(xmlNode* c_node, xmlNode* c_target) except -1:
    cdef xmlNode* c_copy
    cdef xmlNode* c_sibling = c_node
    while c_sibling.prev != NULL and \
            (c_sibling.prev.type == tree.XML_PI_NODE or
             c_sibling.prev.type == tree.XML_COMMENT_NODE or
             c_sibling.prev.type == tree.XML_DTD_NODE):
        c_sibling = c_sibling.prev
    while c_sibling != c_node:
        if c_sibling.type == tree.XML_DTD_NODE:
            c_copy = <xmlNode*>_copyDtd(<tree.xmlDtd*>c_sibling)
            if c_sibling == <xmlNode*>c_node.doc.intSubset:
                c_target.doc.intSubset = <tree.xmlDtd*>c_copy
            else: # c_sibling == c_node.doc.extSubset
                c_target.doc.extSubset = <tree.xmlDtd*>c_copy
        else:
            c_copy = tree.xmlDocCopyNode(c_sibling, c_target.doc, 1)
            if c_copy is NULL:
                raise MemoryError()
        tree.xmlAddPrevSibling(c_target, c_copy)
        c_sibling = c_sibling.next
    while c_sibling.next != NULL and \
            (c_sibling.next.type == tree.XML_PI_NODE or
             c_sibling.next.type == tree.XML_COMMENT_NODE):
        c_sibling = c_sibling.next
        c_copy = tree.xmlDocCopyNode(c_sibling, c_target.doc, 1)
        if c_copy is NULL:
            raise MemoryError()
        tree.xmlAddNextSibling(c_target, c_copy)

cdef int _deleteSlice(_Document doc, xmlNode* c_node,
                      Py_ssize_t count, Py_ssize_t step) except -1:
    """Delete slice, ``count`` items starting with ``c_node`` with a step
    width of ``step``.
    """
    cdef xmlNode* c_next
    cdef Py_ssize_t c, i
    cdef _node_to_node_function next_element
    if c_node is NULL:
        return 0
    if step > 0:
        next_element = _nextElement
    else:
        step = -step
        next_element = _previousElement
    # now start deleting nodes
    c = 0
    c_next = c_node
    while c_node is not NULL and c < count:
        for i in range(step):
            c_next = next_element(c_next)
            if c_next is NULL:
                break
        _removeNode(doc, c_node)
        c += 1
        c_node = c_next
    return 0

cdef int _replaceSlice(_Element parent, xmlNode* c_node,
                       Py_ssize_t slicelength, Py_ssize_t step,
                       bint left_to_right, elements) except -1:
    """Replace the slice of ``count`` elements starting at ``c_node`` with
    positive step width ``step`` by the Elements in ``elements``.  The
    direction is given by the boolean argument ``left_to_right``.

    ``c_node`` may be NULL to indicate the end of the children list.
    """
    cdef xmlNode* c_orig_neighbour
    cdef xmlNode* c_next
    cdef xmlDoc*  c_source_doc
    cdef _Element element
    cdef Py_ssize_t seqlength, i, c
    cdef _node_to_node_function next_element
    assert step > 0
    if left_to_right:
        next_element = _nextElement
    else:
        next_element = _previousElement

    if not isinstance(elements, (list, tuple)):
        elements = list(elements)

    if step != 1 or not left_to_right:
        # *replacing* children stepwise with list => check size!
        seqlength = len(elements)
        if seqlength != slicelength:
            raise ValueError, f"attempt to assign sequence of size {seqlength} " \
                f"to extended slice of size {slicelength}"

    if c_node is NULL:
        # no children yet => add all elements straight away
        if left_to_right:
            for element in elements:
                assert element is not None, "Node must not be None"
                _appendChild(parent, element)
        else:
            for element in elements:
                assert element is not None, "Node must not be None"
                _prependChild(parent, element)
        return 0

    # remove the elements first as some might be re-added
    if left_to_right:
        # L->R, remember left neighbour
        c_orig_neighbour = _previousElement(c_node)
    else:
        # R->L, remember right neighbour
        c_orig_neighbour = _nextElement(c_node)

    # We remove the original slice elements one by one. Since we hold
    # a Python reference to all elements that we will insert, it is
    # safe to let _removeNode() try (and fail) to free them even if
    # the element itself or one of its descendents will be reinserted.
    c = 0
    c_next = c_node
    while c_node is not NULL and c < slicelength:
        for i in range(step):
            c_next = next_element(c_next)
            if c_next is NULL:
                break
        _removeNode(parent._doc, c_node)
        c += 1
        c_node = c_next

    # make sure each element is inserted only once
    elements = iter(elements)

    # find the first node right of the new insertion point
    if left_to_right:
        if c_orig_neighbour is not NULL:
            c_node = next_element(c_orig_neighbour)
        else:
            # before the first element
            c_node = _findChildForwards(parent._c_node, 0)
    elif c_orig_neighbour is NULL:
        # at the end, but reversed stepping
        # append one element and go to the next insertion point
        for element in elements:
            assert element is not None, "Node must not be None"
            _appendChild(parent, element)
            c_node = element._c_node
            if slicelength > 0:
                slicelength -= 1
                for i in range(1, step):
                    c_node = next_element(c_node)
                    if c_node is NULL:
                        break
            break
    else:
        c_node = c_orig_neighbour

    if left_to_right:
        # adjust step size after removing slice as we are not stepping
        # over the newly inserted elements
        step -= 1

    # now insert elements where we removed them
    if c_node is not NULL:
        for element in elements:
            assert element is not None, "Node must not be None"
            _assertValidNode(element)
            # move element and tail over
            c_source_doc = element._c_node.doc
            c_next = element._c_node.next
            tree.xmlAddPrevSibling(c_node, element._c_node)
            _moveTail(c_next, element._c_node)

            # integrate element into new document
            moveNodeToDocument(parent._doc, c_source_doc, element._c_node)

            # stop at the end of the slice
            if slicelength > 0:
                slicelength -= 1
                for i in range(step):
                    c_node = next_element(c_node)
                    if c_node is NULL:
                        break
                if c_node is NULL:
                    break
        else:
            # everything inserted
            return 0

    # append the remaining elements at the respective end
    if left_to_right:
        for element in elements:
            assert element is not None, "Node must not be None"
            _assertValidNode(element)
            _appendChild(parent, element)
    else:
        for element in elements:
            assert element is not None, "Node must not be None"
            _assertValidNode(element)
            _prependChild(parent, element)

    return 0


cdef int _linkChild(xmlNode* c_parent, xmlNode* c_node) except -1:
    """Adaptation of 'xmlAddChild()' that deep-fix the document links iteratively.
    """
    assert _isElement(c_node)
    c_node.parent = c_parent
    if c_parent.children is NULL:
        c_parent.children = c_parent.last = c_node
    else:
        c_node.prev = c_parent.last
        c_parent.last.next = c_node
        c_parent.last = c_node

    _setTreeDoc(c_node, c_parent.doc)
    return 0


cdef int _appendChild(_Element parent, _Element child) except -1:
    """Append a new child to a parent element.
    """
    c_node = child._c_node
    c_source_doc = c_node.doc
    # prevent cycles
    if _isAncestorOrSame(c_node, parent._c_node):
        raise ValueError("cannot append parent to itself")
    # store possible text node
    c_next = c_node.next
    # move node itself
    tree.xmlUnlinkNode(c_node)
    # do not call xmlAddChild() here since it would deep-traverse the tree
    _linkChild(parent._c_node, c_node)
    _moveTail(c_next, c_node)
    # uh oh, elements may be pointing to different doc when
    # parent element has moved; change them too..
    moveNodeToDocument(parent._doc, c_source_doc, c_node)
    return 0

cdef int _prependChild(_Element parent, _Element child) except -1:
    """Prepend a new child to a parent element.
    """
    c_node = child._c_node
    c_source_doc = c_node.doc
    # prevent cycles
    if _isAncestorOrSame(c_node, parent._c_node):
        raise ValueError("cannot append parent to itself")
    # store possible text node
    c_next = c_node.next
    # move node itself
    c_child = _findChildForwards(parent._c_node, 0)
    if c_child is NULL:
        tree.xmlUnlinkNode(c_node)
        # do not call xmlAddChild() here since it would deep-traverse the tree
        _linkChild(parent._c_node, c_node)
    else:
        tree.xmlAddPrevSibling(c_child, c_node)
    _moveTail(c_next, c_node)
    # uh oh, elements may be pointing to different doc when
    # parent element has moved; change them too..
    moveNodeToDocument(parent._doc, c_source_doc, c_node)
    return 0

cdef int _appendSibling(_Element element, _Element sibling) except -1:
    """Add a new sibling behind an element.
    """
    return _addSibling(element, sibling, as_next=True)

cdef int _prependSibling(_Element element, _Element sibling) except -1:
    """Add a new sibling before an element.
    """
    return _addSibling(element, sibling, as_next=False)

cdef int _addSibling(_Element element, _Element sibling, bint as_next) except -1:
    c_node = sibling._c_node
    c_source_doc = c_node.doc
    # prevent cycles
    if _isAncestorOrSame(c_node, element._c_node):
        if element._c_node is c_node:
            return 0  # nothing to do
        raise ValueError("cannot add ancestor as sibling, please break cycle first")
    # store possible text node
    c_next = c_node.next
    # move node itself
    if as_next:
        # must insert after any tail text
        c_next_node = _nextElement(element._c_node)
        if c_next_node is NULL:
            c_next_node = element._c_node
            while c_next_node.next:
                c_next_node = c_next_node.next
            tree.xmlAddNextSibling(c_next_node, c_node)
        else:
            tree.xmlAddPrevSibling(c_next_node, c_node)
    else:
        tree.xmlAddPrevSibling(element._c_node, c_node)
    _moveTail(c_next, c_node)
    # uh oh, elements may be pointing to different doc when
    # parent element has moved; change them too..
    moveNodeToDocument(element._doc, c_source_doc, c_node)
    return 0

cdef inline bint isutf8(const_xmlChar* s) noexcept:
    cdef xmlChar c = s[0]
    while c != c'\0':
        if c & 0x80:
            return True
        s += 1
        c = s[0]
    return False

cdef bint isutf8l(const_xmlChar* s, size_t length) noexcept:
    """
    Search for non-ASCII characters in the string, knowing its length in advance.
    """
    cdef unsigned int i
    cdef unsigned long non_ascii_mask
    cdef const unsigned long *lptr = <const unsigned long*> s

    cdef const unsigned long *end = lptr + length // sizeof(unsigned long)
    if length >= sizeof(non_ascii_mask):
        # Build constant 0x80808080... mask (and let the C compiler fold it).
        non_ascii_mask = 0
        for i in range(sizeof(non_ascii_mask) // 2):
            non_ascii_mask = (non_ascii_mask << 16) | 0x8080

        # Advance to long-aligned character before we start reading longs.
        while (<size_t>s) % sizeof(unsigned long) and s < <const_xmlChar *>end:
            if s[0] & 0x80:
                return True
            s += 1

        # Read one long at a time
        lptr = <const unsigned long*> s
        while lptr < end:
            if lptr[0] & non_ascii_mask:
                return True
            lptr += 1
        s = <const_xmlChar *>lptr

    while s < (<const_xmlChar *>end + length % sizeof(unsigned long)):
        if s[0] & 0x80:
            return True
        s += 1

    return False

cdef int _is_valid_xml_ascii(bytes pystring) except -1:
    """Check if a string is XML ascii content."""
    cdef signed char ch
    # When ch is a *signed* char, non-ascii characters are negative integers
    # and xmlIsChar_ch does not accept them.
    for ch in pystring:
        if not tree.xmlIsChar_ch(ch):
            return 0
    return 1

cdef bint _is_valid_xml_utf8(bytes pystring) except -1:
    """Check if a string is like valid UTF-8 XML content."""
    cdef const_xmlChar* s = _xcstr(pystring)
    cdef const_xmlChar* c_end = s + len(pystring)
    cdef unsigned long next3 = 0
    if s < c_end - 2:
        next3 = (s[0] << 8) | (s[1])

    while s < c_end - 2:
        next3 = 0x00ffffff & ((next3 << 8) | s[2])
        if s[0] & 0x80:
            # 0xefbfbe and 0xefbfbf are utf-8 encodings of
            # forbidden characters \ufffe and \uffff
            if next3 == 0x00efbfbe or next3 == 0x00efbfbf:
                return 0
            # 0xeda080 and 0xedbfbf are utf-8 encodings of
            # \ud800 and \udfff. Anything between them (inclusive)
            # is forbidden, because they are surrogate blocks in utf-16.
            if 0x00eda080 <= next3 <= 0x00edbfbf:
                return 0
        elif not tree.xmlIsChar_ch(s[0]):
            return 0  # invalid ascii char
        s += 1

    while s < c_end:
        if not s[0] & 0x80 and not tree.xmlIsChar_ch(s[0]):
            return 0  # invalid ascii char
        s += 1

    return 1

cdef inline unicode funicodeOrNone(const_xmlChar* s):
    return funicode(s) if s is not NULL else None

cdef inline unicode funicodeOrEmpty(const_xmlChar* s):
    return funicode(s) if s is not NULL else ''

cdef unicode funicode(const_xmlChar* s):
    return s.decode('UTF-8')

cdef bytes _utf8(object s):
    """Test if a string is valid user input and encode it to UTF-8.
    Reject all bytes/unicode input that contains non-XML characters.
    Reject all bytes input that contains non-ASCII characters.
    """
    cdef int valid
    cdef bytes utf8_string
    if isinstance(s, unicode):
        utf8_string = (<unicode>s).encode('utf8')
        valid = _is_valid_xml_utf8(utf8_string)
    elif isinstance(s, (bytes, bytearray)):
        utf8_string = s if type(s) is bytes else bytes(s)
        valid = _is_valid_xml_ascii(utf8_string)
    else:
        raise TypeError("Argument must be bytes or unicode, got '%.200s'" % type(s).__name__)
    if not valid:
        raise ValueError(
            "All strings must be XML compatible: Unicode or ASCII, no NULL bytes or control characters")
    return utf8_string


cdef bytes _utf8orNone(object s):
    return _utf8(s) if s is not None else None


cdef enum:
    NO_FILE_PATH = 0
    ABS_UNIX_FILE_PATH = 1
    ABS_WIN_FILE_PATH = 2
    REL_FILE_PATH = 3


cdef bint _isFilePath(const_xmlChar* c_path) noexcept:
    "simple heuristic to see if a path is a filename"
    cdef xmlChar c
    # test if it looks like an absolute Unix path or a Windows network path
    if c_path[0] == c'/':
        return ABS_UNIX_FILE_PATH

    # test if it looks like an absolute Windows path or URL
    if c'a' <= c_path[0] <= c'z' or c'A' <= c_path[0] <= c'Z':
        c_path += 1
        if c_path[0] == c':' and c_path[1] in b'\0\\':
            return ABS_WIN_FILE_PATH  # C: or C:\...

        # test if it looks like a URL with scheme://
        while c'a' <= c_path[0] <= c'z' or c'A' <= c_path[0] <= c'Z':
            c_path += 1
        if c_path[0] == c':' and c_path[1] == c'/' and c_path[2] == c'/':
            return NO_FILE_PATH

    # assume it's a relative path
    return REL_FILE_PATH


cdef object _getFSPathOrObject(object obj):
    """
    Get the __fspath__ attribute of an object if it exists.
    Otherwise, the original object is returned.
    """
    if _isString(obj):
        return obj
    try:
        return python.PyOS_FSPath(obj)
    except TypeError:
        return obj


cdef object _encodeFilename(object filename):
    """Make sure a filename is 8-bit encoded (or None).
    """
    if filename is None:
        return None
    elif isinstance(filename, bytes):
        return filename
    elif isinstance(filename, unicode):
        filename8 = (<unicode>filename).encode('utf8')
        if _isFilePath(<unsigned char*>filename8):
            try:
                return python.PyUnicode_AsEncodedString(
                    filename, _C_FILENAME_ENCODING, NULL)
            except UnicodeEncodeError:
                pass
        return filename8
    else:
        raise TypeError("Argument must be string or unicode.")

cdef object _decodeFilename(const_xmlChar* c_path):
    """Make the filename a unicode string if we are in Py3.
    """
    return _decodeFilenameWithLength(c_path, tree.xmlStrlen(c_path))

cdef object _decodeFilenameWithLength(const_xmlChar* c_path, size_t c_len):
    """Make the filename a unicode string if we are in Py3.
    """
    if _isFilePath(c_path):
        try:
            return python.PyUnicode_Decode(
                <const_char*>c_path, c_len, _C_FILENAME_ENCODING, NULL)
        except UnicodeDecodeError:
            pass
    try:
        return (<unsigned char*>c_path)[:c_len].decode('UTF-8')
    except UnicodeDecodeError:
        # this is a stupid fallback, but it might still work...
        return (<unsigned char*>c_path)[:c_len].decode('latin-1', 'replace')

cdef object _encodeFilenameUTF8(object filename):
    """Recode filename as UTF-8. Tries ASCII, local filesystem encoding and
    UTF-8 as source encoding.
    """
    cdef char* c_filename
    if filename is None:
        return None
    elif isinstance(filename, bytes):
        if not isutf8l(<bytes>filename, len(<bytes>filename)):
            # plain ASCII!
            return filename
        c_filename = _cstr(<bytes>filename)
        try:
            # try to decode with default encoding
            filename = python.PyUnicode_Decode(
                c_filename, len(<bytes>filename),
                _C_FILENAME_ENCODING, NULL)
        except UnicodeDecodeError as decode_exc:
            try:
                # try if it's proper UTF-8
                (<bytes>filename).decode('utf8')
                return filename
            except UnicodeDecodeError:
                raise decode_exc # otherwise re-raise original exception
    if isinstance(filename, unicode):
        return (<unicode>filename).encode('utf8')
    else:
        raise TypeError("Argument must be string or unicode.")

cdef tuple _getNsTag(tag):
    """Given a tag, find namespace URI and tag name.
    Return None for NS uri if no namespace URI provided.
    """
    return __getNsTag(tag, 0)

cdef tuple _getNsTagWithEmptyNs(tag):
    """Given a tag, find namespace URI and tag name.  Return None for NS uri
    if no namespace URI provided, or the empty string if namespace
    part is '{}'.
    """
    return __getNsTag(tag, 1)

cdef tuple __getNsTag(tag, bint empty_ns):
    cdef char* c_tag
    cdef char* c_ns_end
    cdef Py_ssize_t taglen
    cdef Py_ssize_t nslen
    cdef bytes ns = None
    # _isString() is much faster than isinstance()
    if not _isString(tag) and isinstance(tag, QName):
        tag = (<QName>tag).text
    tag = _utf8(tag)
    c_tag = _cstr(tag)
    if c_tag[0] == c'{':
        c_tag += 1
        c_ns_end = cstring_h.strchr(c_tag, c'}')
        if c_ns_end is NULL:
            raise ValueError, "Invalid tag name"
        nslen  = c_ns_end - c_tag
        taglen = python.PyBytes_GET_SIZE(tag) - nslen - 2
        if taglen == 0:
            raise ValueError, "Empty tag name"
        if nslen > 0:
            ns = <bytes>c_tag[:nslen]
        elif empty_ns:
            ns = b''
        tag = <bytes>c_ns_end[1:taglen+1]
    elif python.PyBytes_GET_SIZE(tag) == 0:
        raise ValueError, "Empty tag name"
    return ns, tag

cdef inline int _pyXmlNameIsValid(name_utf8):
    return _xmlNameIsValid(_xcstr(name_utf8)) and b':' not in name_utf8

cdef inline int _pyHtmlNameIsValid(name_utf8):
    return _htmlNameIsValid(_xcstr(name_utf8))

cdef inline int _xmlNameIsValid(const_xmlChar* c_name) noexcept:
    return tree.xmlValidateNameValue(c_name)

cdef int _htmlNameIsValid(const_xmlChar* c_name) noexcept:
    if c_name is NULL or c_name[0] == c'\0':
        return 0
    while c_name[0] != c'\0':
        if c_name[0] in b'&<>/"\'\t\n\x0B\x0C\r ':
            return 0
        c_name += 1
    return 1

cdef bint _characterReferenceIsValid(const_xmlChar* c_name) noexcept:
    cdef bint is_hex
    if c_name[0] == c'x':
        c_name += 1
        is_hex = 1
    else:
        is_hex = 0
    if c_name[0] == c'\0':
        return 0
    while c_name[0] != c'\0':
        if c_name[0] < c'0' or c_name[0] > c'9':
            if not is_hex:
                return 0
            if not (c'a' <= c_name[0] <= c'f'):
                if not (c'A' <= c_name[0] <= c'F'):
                    return 0
        c_name += 1
    return 1

cdef int _tagValidOrRaise(tag_utf) except -1:
    if not _pyXmlNameIsValid(tag_utf):
        raise ValueError(f"Invalid tag name {(<bytes>tag_utf).decode('utf8')!r}")
    return 0

cdef int _htmlTagValidOrRaise(tag_utf) except -1:
    if not _pyHtmlNameIsValid(tag_utf):
        raise ValueError(f"Invalid HTML tag name {(<bytes>tag_utf).decode('utf8')!r}")
    return 0

cdef int _attributeValidOrRaise(name_utf) except -1:
    if not _pyXmlNameIsValid(name_utf):
        raise ValueError(f"Invalid attribute name {(<bytes>name_utf).decode('utf8')!r}")
    return 0

cdef int _prefixValidOrRaise(tag_utf) except -1:
    if not _pyXmlNameIsValid(tag_utf):
        raise ValueError(f"Invalid namespace prefix {(<bytes>tag_utf).decode('utf8')!r}")
    return 0

cdef int _uriValidOrRaise(uri_utf) except -1:
    cdef uri.xmlURI* c_uri = uri.xmlParseURI(_cstr(uri_utf))
    if c_uri is NULL:
        raise ValueError(f"Invalid namespace URI {(<bytes>uri_utf).decode('utf8')!r}")
    uri.xmlFreeURI(c_uri)
    return 0

cdef inline unicode _namespacedName(xmlNode* c_node):
    return _namespacedNameFromNsName(_getNs(c_node), c_node.name)


cdef unicode _namespacedNameFromNsName(const_xmlChar* c_href, const_xmlChar* c_name):
    name = funicode(c_name)
    if c_href is NULL:
        return name
    href = funicode(c_href)
    return f"{{{href}}}{name}"


cdef _getFilenameForFile(source):
    """Given a Python File or Gzip object, give filename back.

    Returns None if not a file object.
    """
    # urllib2 provides a geturl() method
    try:
        return source.geturl()
    except:
        pass
    # file instances have a name attribute
    try:
        filename = source.name
        if _isString(filename):
            return os_path_abspath(filename)
    except:
        pass
    # gzip file instances have a filename attribute (before Py3k)
    try:
        filename = source.filename
        if _isString(filename):
            return os_path_abspath(filename)
    except:
        pass
    # can't determine filename
    return None
