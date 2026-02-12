# Proxy functions and low level node allocation stuff

# Proxies represent elements, their reference is stored in the C
# structure of the respective node to avoid multiple instantiation of
# the Python class.

@cython.linetrace(False)
@cython.profile(False)
cdef inline _Element getProxy(xmlNode* c_node):
    """Get a proxy for a given node.
    """
    #print "getProxy for:", <int>c_node
    if c_node is not NULL and c_node._private is not NULL:
        return <_Element>c_node._private
    else:
        return None


@cython.linetrace(False)
@cython.profile(False)
cdef inline bint hasProxy(xmlNode* c_node):
    if c_node._private is NULL:
        return False
    return True


@cython.linetrace(False)
@cython.profile(False)
cdef inline int _registerProxy(_Element proxy, _Document doc,
                               xmlNode* c_node) except -1:
    """Register a proxy and type for the node it's proxying for.
    """
    #print "registering for:", <int>proxy._c_node
    assert not hasProxy(c_node), "double registering proxy!"
    proxy._doc = doc
    proxy._c_node = c_node
    c_node._private = <void*>proxy
    return 0


@cython.linetrace(False)
@cython.profile(False)
cdef inline int _unregisterProxy(_Element proxy) except -1:
    """Unregister a proxy for the node it's proxying for.
    """
    cdef xmlNode* c_node = proxy._c_node
    assert c_node._private is <void*>proxy, "Tried to unregister unknown proxy"
    c_node._private = NULL
    return 0


################################################################################
# temporarily make a node the root node of its document

cdef xmlDoc* _fakeRootDoc(xmlDoc* c_base_doc, xmlNode* c_node) except NULL:
    return _plainFakeRootDoc(c_base_doc, c_node, 1)

cdef xmlDoc* _plainFakeRootDoc(xmlDoc* c_base_doc, xmlNode* c_node,
                               bint with_siblings) except NULL:
    # build a temporary document that has the given node as root node
    # note that copy and original must not be modified during its lifetime!!
    # always call _destroyFakeDoc() after use!
    cdef xmlNode* c_child
    cdef xmlNode* c_root
    cdef xmlNode* c_new_root
    cdef xmlDoc*  c_doc
    if with_siblings or (c_node.prev is NULL and c_node.next is NULL):
        c_root = tree.xmlDocGetRootElement(c_base_doc)
        if c_root is c_node:
            # already the root node, no siblings
            return c_base_doc

    c_doc  = _copyDoc(c_base_doc, 0)                   # non recursive!
    c_new_root = tree.xmlDocCopyNode(c_node, c_doc, 2) # non recursive!
    tree.xmlDocSetRootElement(c_doc, c_new_root)
    _copyParentNamespaces(c_node, c_new_root)

    c_new_root.children = c_node.children
    c_new_root.last = c_node.last
    c_new_root.next = c_new_root.prev = NULL

    # store original node
    c_doc._private = c_node

    # divert parent pointers of children
    c_child = c_new_root.children
    while c_child is not NULL:
        c_child.parent = c_new_root
        c_child = c_child.next

    c_doc.children = c_new_root
    return c_doc

cdef void _destroyFakeDoc(xmlDoc* c_base_doc, xmlDoc* c_doc) noexcept:
    # delete a temporary document
    cdef xmlNode* c_child
    cdef xmlNode* c_parent
    cdef xmlNode* c_root
    if c_doc is c_base_doc:
        return
    c_root = tree.xmlDocGetRootElement(c_doc)

    # restore parent pointers of children
    c_parent = <xmlNode*>c_doc._private
    c_child = c_root.children
    while c_child is not NULL:
        c_child.parent = c_parent
        c_child = c_child.next

    # prevent recursive removal of children
    c_root.children = c_root.last = NULL
    tree.xmlFreeDoc(c_doc)

cdef _Element _fakeDocElementFactory(_Document doc, xmlNode* c_element):
    """Special element factory for cases where we need to create a fake
    root document, but still need to instantiate arbitrary nodes from
    it.  If we instantiate the fake root node, things will turn bad
    when it's destroyed.

    Instead, if we are asked to instantiate the fake root node, we
    instantiate the original node instead.
    """
    if c_element.doc is not doc._c_doc:
        if c_element.doc._private is not NULL:
            if c_element is c_element.doc.children:
                c_element = <xmlNode*>c_element.doc._private
                #assert c_element.type == tree.XML_ELEMENT_NODE
    return _elementFactory(doc, c_element)

################################################################################
# support for freeing tree elements when proxy objects are destroyed

cdef int attemptDeallocation(xmlNode* c_node) noexcept:
    """Attempt deallocation of c_node (or higher up in tree).
    """
    cdef xmlNode* c_top
    # could be we actually aren't referring to the tree at all
    if c_node is NULL:
        #print "not freeing, node is NULL"
        return 0
    c_top = getDeallocationTop(c_node)
    if c_top is not NULL:
        #print "freeing:", c_top.name
        _removeText(c_top.next) # tail
        tree.xmlFreeNode(c_top)
        return 1
    return 0

cdef xmlNode* getDeallocationTop(xmlNode* c_node) noexcept:
    """Return the top of the tree that can be deallocated, or NULL.
    """
    cdef xmlNode* c_next
    #print "trying to do deallocating:", c_node.type
    if hasProxy(c_node):
        #print "Not freeing: proxies still exist"
        return NULL
    while c_node.parent is not NULL:
        c_node = c_node.parent
        #print "checking:", c_current.type
        if c_node.type == tree.XML_DOCUMENT_NODE or \
               c_node.type == tree.XML_HTML_DOCUMENT_NODE:
            #print "not freeing: still in doc"
            return NULL
        # if we're still attached to the document, don't deallocate
        if hasProxy(c_node):
            #print "Not freeing: proxies still exist"
            return NULL
    # see whether we have children to deallocate
    if not canDeallocateChildNodes(c_node):
        return NULL
    # see whether we have siblings to deallocate
    c_next = c_node.prev
    while c_next:
        if _isElement(c_next):
            if hasProxy(c_next) or not canDeallocateChildNodes(c_next):
                return NULL
        c_next = c_next.prev
    c_next = c_node.next
    while c_next:
        if _isElement(c_next):
            if hasProxy(c_next) or not canDeallocateChildNodes(c_next):
                return NULL
        c_next = c_next.next
    return c_node

cdef int canDeallocateChildNodes(xmlNode* c_parent) noexcept:
    cdef xmlNode* c_node
    c_node = c_parent.children
    tree.BEGIN_FOR_EACH_ELEMENT_FROM(c_parent, c_node, 1)
    if hasProxy(c_node):
        return 0
    tree.END_FOR_EACH_ELEMENT_FROM(c_node)
    return 1

################################################################################
# fix _Document references and namespaces when a node changes documents

cdef void _copyParentNamespaces(xmlNode* c_from_node, xmlNode* c_to_node) noexcept nogil:
    """Copy the namespaces of all ancestors of c_from_node to c_to_node.
    """
    cdef xmlNode* c_parent
    cdef xmlNs* c_ns
    cdef xmlNs* c_new_ns
    cdef int prefix_known
    c_parent = c_from_node.parent
    while c_parent and (tree._isElementOrXInclude(c_parent) or
                        c_parent.type == tree.XML_DOCUMENT_NODE):
        c_new_ns = c_parent.nsDef
        while c_new_ns:
            # libxml2 will check if the prefix is already defined
            tree.xmlNewNs(c_to_node, c_new_ns.href, c_new_ns.prefix)
            c_new_ns = c_new_ns.next
        c_parent = c_parent.parent


ctypedef struct _ns_update_map:
    xmlNs* old
    xmlNs* new


ctypedef struct _nscache:
    _ns_update_map* ns_map
    size_t size
    size_t last


cdef int _growNsCache(_nscache* c_ns_cache) except -1:
    cdef _ns_update_map* ns_map_ptr
    if c_ns_cache.size == 0:
        c_ns_cache.size = 20
    else:
        c_ns_cache.size *= 2
    ns_map_ptr = <_ns_update_map*> python.lxml_realloc(
        c_ns_cache.ns_map, c_ns_cache.size, sizeof(_ns_update_map))
    if not ns_map_ptr:
        python.lxml_free(c_ns_cache.ns_map)
        c_ns_cache.ns_map = NULL
        raise MemoryError()
    c_ns_cache.ns_map = ns_map_ptr
    return 0


cdef inline int _appendToNsCache(_nscache* c_ns_cache,
                                 xmlNs* c_old_ns, xmlNs* c_new_ns) except -1:
    if c_ns_cache.last >= c_ns_cache.size:
        _growNsCache(c_ns_cache)
    c_ns_cache.ns_map[c_ns_cache.last] = _ns_update_map(old=c_old_ns, new=c_new_ns)
    c_ns_cache.last += 1


cdef int _stripRedundantNamespaceDeclarations(xmlNode* c_element, _nscache* c_ns_cache,
                                              xmlNs** c_del_ns_list) except -1:
    """Removes namespace declarations from an element that are already
    defined in its parents.  Does not free the xmlNs's, just prepends
    them to the c_del_ns_list.
    """
    cdef xmlNs* c_ns
    cdef xmlNs* c_ns_next
    cdef xmlNs** c_nsdef
    # use a xmlNs** to handle assignments to "c_element.nsDef" correctly
    c_nsdef = &c_element.nsDef
    while c_nsdef[0] is not NULL:
        c_ns = tree.xmlSearchNsByHref(
            c_element.doc, c_element.parent, c_nsdef[0].href)
        if c_ns is NULL:
            # new namespace href => keep and cache the ns declaration
            _appendToNsCache(c_ns_cache, c_nsdef[0], c_nsdef[0])
            c_nsdef = &c_nsdef[0].next
        else:
            # known namespace href => cache mapping and strip old ns
            _appendToNsCache(c_ns_cache, c_nsdef[0], c_ns)
            # cut out c_nsdef.next and prepend it to garbage chain
            c_ns_next = c_nsdef[0].next
            c_nsdef[0].next = c_del_ns_list[0]
            c_del_ns_list[0] = c_nsdef[0]
            c_nsdef[0] = c_ns_next
    return 0


cdef void _cleanUpFromNamespaceAdaptation(xmlNode* c_start_node,
                                          _nscache* c_ns_cache, xmlNs* c_del_ns_list) noexcept:
    # Try to recover from exceptions with really bad timing.  We were in the middle
    # of ripping out xmlNS-es and likely ran out of memory.  Try to fix up the tree
    # by re-adding the original xmlNs declarations (which might still be used in some
    # places).
    if c_ns_cache.ns_map:
        python.lxml_free(c_ns_cache.ns_map)
    if c_del_ns_list:
        if not c_start_node.nsDef:
            c_start_node.nsDef = c_del_ns_list
        else:
            c_ns = c_start_node.nsDef
            while c_ns.next:
                c_ns = c_ns.next
            c_ns.next = c_del_ns_list


cdef int moveNodeToDocument(_Document doc, xmlDoc* c_source_doc,
                            xmlNode* c_element) except -1:
    """Fix the xmlNs pointers of a node and its subtree that were moved.

    Originally copied from libxml2's xmlReconciliateNs().  Expects
    libxml2 doc pointers of node to be correct already, but fixes
    _Document references.

    For each node in the subtree, we do this:

    1) Remove redundant declarations of namespace that are already
       defined in its parents.

    2) Replace namespaces that are *not* defined on the node or its
       parents by the equivalent namespace declarations that *are*
       defined on the node or its parents (possibly using a different
       prefix).  If a namespace is unknown, declare a new one on the
       node.

    3) Reassign the names of tags and attribute from the dict of the
       target document *iff* it is different from the dict used in the
       source subtree.

    4) Set the Document reference to the new Document (if different).
       This is done on backtracking to keep the original Document
       alive as long as possible, until all its elements are updated.

    Note that the namespace declarations are removed from the tree in
    step 1), but freed only after the complete subtree was traversed
    and all occurrences were replaced by tree-internal pointers.
    """
    cdef xmlNode* c_start_node
    cdef xmlNode* c_node
    cdef xmlDoc* c_doc = doc._c_doc
    cdef tree.xmlAttr* c_attr
    cdef char* c_name
    cdef _nscache c_ns_cache = [NULL, 0, 0]
    cdef xmlNs* c_del_ns_list = NULL
    cdef proxy_count = 0

    if not tree._isElementOrXInclude(c_element):
        return 0

    c_start_node = c_element

    tree.BEGIN_FOR_EACH_FROM(c_element, c_element, 1)
    if tree._isElementOrXInclude(c_element):
        if hasProxy(c_element):
            proxy_count += 1

        # 1) cut out namespaces defined here that are already known by
        #    the ancestors
        if c_element.nsDef is not NULL:
            try:
                _stripRedundantNamespaceDeclarations(c_element, &c_ns_cache, &c_del_ns_list)
            except:
                _cleanUpFromNamespaceAdaptation(c_start_node, &c_ns_cache, c_del_ns_list)
                raise

        # 2) make sure the namespaces of an element and its attributes
        #    are declared in this document (i.e. on the node or its parents)
        if c_element.ns is not NULL:
            _fixCNs(doc, c_start_node, c_element, &c_ns_cache, c_del_ns_list)

        c_node = <xmlNode*>c_element.properties
        while c_node is not NULL:
            if c_node.ns is not NULL:
                _fixCNs(doc, c_start_node, c_node, &c_ns_cache, c_del_ns_list)
            c_node = c_node.next

    tree.END_FOR_EACH_FROM(c_element)

    # free now unused namespace declarations
    if c_del_ns_list is not NULL:
        tree.xmlFreeNsList(c_del_ns_list)

    # cleanup
    if c_ns_cache.ns_map is not NULL:
        python.lxml_free(c_ns_cache.ns_map)

    # 3) fix the names in the tree if we moved it from a different thread
    if doc._c_doc.dict is not c_source_doc.dict:
        fixThreadDictNames(c_start_node, c_source_doc.dict, doc._c_doc.dict)

    # 4) fix _Document references
    #    (and potentially deallocate the source document)
    if proxy_count > 0:
        if proxy_count == 1 and c_start_node._private is not NULL:
            proxy = getProxy(c_start_node)
            if proxy is not None:
                if proxy._doc is not doc:
                    proxy._doc = doc
            else:
                fixElementDocument(c_start_node, doc, proxy_count)
        else:
            fixElementDocument(c_start_node, doc, proxy_count)

    return 0


cdef void _setTreeDoc(xmlNode* c_node, xmlDoc* c_doc) noexcept:
    """Adaptation of 'xmlSetTreeDoc()' that deep-fixes the document links iteratively.
    It avoids https://gitlab.gnome.org/GNOME/libxml2/issues/42
    """
    tree.BEGIN_FOR_EACH_FROM(c_node, c_node, 1)
    if c_node.type == tree.XML_ELEMENT_NODE:
        c_attr = <tree.xmlAttr*>c_node.properties
        while c_attr:
            if c_attr.atype == tree.XML_ATTRIBUTE_ID:
                tree.xmlRemoveID(c_node.doc, c_attr)
            c_attr.doc = c_doc
            _fixDocChildren(c_attr.children, c_doc)
            c_attr = c_attr.next
    # Set doc link for all nodes, not only elements.
    c_node.doc = c_doc
    tree.END_FOR_EACH_FROM(c_node)


cdef inline void _fixDocChildren(xmlNode* c_child, xmlDoc* c_doc) noexcept:
    while c_child:
        c_child.doc = c_doc
        if c_child.children:
            _fixDocChildren(c_child.children, c_doc)
        c_child = c_child.next


cdef int _fixCNs(_Document doc, xmlNode* c_start_node, xmlNode* c_node,
                 _nscache* c_ns_cache, xmlNs* c_del_ns_list) except -1:
    cdef xmlNs* c_ns = NULL
    cdef bint is_prefixed_attr = (c_node.type == tree.XML_ATTRIBUTE_NODE and c_node.ns.prefix)

    for ns_map in c_ns_cache.ns_map[:c_ns_cache.last]:
        if c_node.ns is ns_map.old:
            if is_prefixed_attr and not ns_map.new.prefix:
                # avoid dropping prefix from attributes
                continue
            c_ns = ns_map.new
            break

    if c_ns:
        c_node.ns = c_ns
    else:
        # not in cache or not acceptable
        # => find a replacement from this document
        try:
            c_ns = doc._findOrBuildNodeNs(
                c_start_node, c_node.ns.href, c_node.ns.prefix,
                c_node.type == tree.XML_ATTRIBUTE_NODE)
            c_node.ns = c_ns
            _appendToNsCache(c_ns_cache, c_node.ns, c_ns)
        except:
            _cleanUpFromNamespaceAdaptation(c_start_node, c_ns_cache, c_del_ns_list)
            raise
    return 0


cdef int fixElementDocument(xmlNode* c_element, _Document doc,
                             size_t proxy_count) except -1:
    cdef xmlNode* c_node = c_element
    cdef _Element proxy = None # init-to-None required due to fake-loop below
    tree.BEGIN_FOR_EACH_FROM(c_element, c_node, 1)
    if c_node._private is not NULL:
        proxy = getProxy(c_node)
        if proxy is not None:
            if proxy._doc is not doc:
                proxy._doc = doc
            proxy_count -= 1
            if proxy_count == 0:
                return 0
    tree.END_FOR_EACH_FROM(c_node)


cdef void fixThreadDictNames(xmlNode* c_element,
                             tree.xmlDict* c_src_dict,
                             tree.xmlDict* c_dict) noexcept nogil:
    # re-assign the names of tags and attributes
    #
    # this should only be called when the element is based on a
    # different libxml2 tag name dictionary
    if c_element.type == tree.XML_DOCUMENT_NODE or \
            c_element.type == tree.XML_HTML_DOCUMENT_NODE:
        # may define "xml" namespace
        fixThreadDictNsForNode(c_element, c_src_dict, c_dict)
        if c_element.doc.extSubset:
            fixThreadDictNamesForDtd(c_element.doc.extSubset, c_src_dict, c_dict)
        if c_element.doc.intSubset:
            fixThreadDictNamesForDtd(c_element.doc.intSubset, c_src_dict, c_dict)
        c_element = c_element.children
        while c_element is not NULL:
            fixThreadDictNamesForNode(c_element, c_src_dict, c_dict)
            c_element = c_element.next
    elif tree._isElementOrXInclude(c_element):
        fixThreadDictNamesForNode(c_element, c_src_dict, c_dict)


cdef inline void _fixThreadDictPtr(const_xmlChar** c_ptr,
                                   tree.xmlDict* c_src_dict,
                                   tree.xmlDict* c_dict) noexcept nogil:
    c_str = c_ptr[0]
    if c_str and c_src_dict and tree.xmlDictOwns(c_src_dict, c_str):
        # return value can be NULL on memory error, but we don't handle that here
        c_str = tree.xmlDictLookup(c_dict, c_str, -1)
        if c_str:
            c_ptr[0] = c_str


cdef void fixThreadDictNamesForNode(xmlNode* c_element,
                                    tree.xmlDict* c_src_dict,
                                    tree.xmlDict* c_dict) noexcept nogil:
    cdef xmlNode* c_node = c_element
    tree.BEGIN_FOR_EACH_FROM(c_element, c_node, 1)
    if c_node.type in (tree.XML_ELEMENT_NODE, tree.XML_XINCLUDE_START):
        fixThreadDictNamesForAttributes(
            c_node.properties, c_src_dict, c_dict)
        fixThreadDictNsForNode(c_node, c_src_dict, c_dict)
        _fixThreadDictPtr(&c_node.name, c_src_dict, c_dict)
    elif c_node.type == tree.XML_TEXT_NODE:
        # libxml2's SAX2 parser interns some indentation space
        fixThreadDictContentForNode(c_node, c_src_dict, c_dict)
    elif c_node.type == tree.XML_COMMENT_NODE:
        pass  # don't touch c_node.name
    else:
        _fixThreadDictPtr(&c_node.name, c_src_dict, c_dict)
    tree.END_FOR_EACH_FROM(c_node)


cdef inline void fixThreadDictNamesForAttributes(tree.xmlAttr* c_attr,
                                                 tree.xmlDict* c_src_dict,
                                                 tree.xmlDict* c_dict) noexcept nogil:
    cdef xmlNode* c_child
    cdef xmlNode* c_node = <xmlNode*>c_attr
    while c_node is not NULL:
        if c_node.type not in (tree.XML_TEXT_NODE, tree.XML_COMMENT_NODE):
            _fixThreadDictPtr(&c_node.name, c_src_dict, c_dict)
        # libxml2 keeps some (!) attribute values in the dict
        c_child = c_node.children
        while c_child is not NULL:
            fixThreadDictContentForNode(c_child, c_src_dict, c_dict)
            c_child = c_child.next
        c_node = c_node.next


cdef inline void fixThreadDictContentForNode(xmlNode* c_node,
                                             tree.xmlDict* c_src_dict,
                                             tree.xmlDict* c_dict) noexcept nogil:
    if c_node.content is not NULL and \
           c_node.content is not <xmlChar*>&c_node.properties:
        if tree.xmlDictOwns(c_src_dict, c_node.content):
            # result can be NULL on memory error, but we don't handle that here
            c_node.content = <xmlChar*>tree.xmlDictLookup(c_dict, c_node.content, -1)


cdef inline void fixThreadDictNsForNode(xmlNode* c_node,
                                        tree.xmlDict* c_src_dict,
                                        tree.xmlDict* c_dict) noexcept nogil:
    cdef xmlNs* c_ns = c_node.nsDef
    while c_ns is not NULL:
        _fixThreadDictPtr(&c_ns.href, c_src_dict, c_dict)
        _fixThreadDictPtr(&c_ns.prefix, c_src_dict, c_dict)
        c_ns = c_ns.next


cdef void fixThreadDictNamesForDtd(tree.xmlDtd* c_dtd,
                                   tree.xmlDict* c_src_dict,
                                   tree.xmlDict* c_dict) noexcept nogil:
    cdef xmlNode* c_node
    cdef tree.xmlElement* c_element
    cdef tree.xmlAttribute* c_attribute
    cdef tree.xmlEntity* c_entity

    c_node = c_dtd.children
    while c_node:
        if c_node.type == tree.XML_ELEMENT_DECL:
            c_element = <tree.xmlElement*>c_node
            if c_element.content:
                _fixThreadDictPtr(&c_element.content.name, c_src_dict, c_dict)
                _fixThreadDictPtr(&c_element.content.prefix, c_src_dict, c_dict)
            c_attribute = c_element.attributes
            while c_attribute:
                if tree.LIBXML_VERSION < 21500:
                    # libxml2 2.15 no longer stores default values in the dict.
                    # See https://gitlab.gnome.org/GNOME/libxml2/-/commit/24628f25
                    _fixThreadDictPtr(<const_xmlChar**>&c_attribute.defaultValue, c_src_dict, c_dict)
                _fixThreadDictPtr(&c_attribute.name, c_src_dict, c_dict)
                _fixThreadDictPtr(&c_attribute.prefix, c_src_dict, c_dict)
                _fixThreadDictPtr(&c_attribute.elem, c_src_dict, c_dict)
                c_attribute = c_attribute.nexth
        elif c_node.type == tree.XML_ENTITY_DECL:
            c_entity = <tree.xmlEntity*>c_node
            _fixThreadDictPtr(&c_entity.name, c_src_dict, c_dict)
            _fixThreadDictPtr(&c_entity.ExternalID, c_src_dict, c_dict)
            _fixThreadDictPtr(&c_entity.SystemID, c_src_dict, c_dict)
            _fixThreadDictPtr(<const_xmlChar**>&c_entity.content, c_src_dict, c_dict)
        c_node = c_node.next


################################################################################
# adopt an xmlDoc from an external libxml2 document source

cdef _Document _adoptForeignDoc(xmlDoc* c_doc, _BaseParser parser=None, bint is_owned=True):
    """Convert and wrap an externally produced xmlDoc for use in lxml.
    Assures that all '_private' pointers are NULL to prevent accidental
    dereference into lxml proxy objects.
    """
    if c_doc is NULL:
        raise ValueError("Illegal document provided: NULL")
    if c_doc.type not in (tree.XML_DOCUMENT_NODE, tree.XML_HTML_DOCUMENT_NODE):
        doc_type = c_doc.type
        if is_owned:
            tree.xmlFreeDoc(c_doc)
        raise ValueError(f"Illegal document provided: expected XML or HTML, found {doc_type}")

    cdef xmlNode* c_node = <xmlNode*>c_doc

    if is_owned:
        tree.BEGIN_FOR_EACH_FROM(<xmlNode*>c_doc, c_node, 1)
        c_node._private = NULL
        tree.END_FOR_EACH_FROM(c_node)
    else:
        # create a fresh copy that lxml owns
        c_doc = tree.xmlCopyDoc(c_doc, 1)
        if c_doc is NULL:
            raise MemoryError()

    return _documentFactory(c_doc, parser)
