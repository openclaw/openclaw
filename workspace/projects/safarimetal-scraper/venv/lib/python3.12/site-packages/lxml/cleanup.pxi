# functions for tree cleanup and removing elements from subtrees

def cleanup_namespaces(tree_or_element, top_nsmap=None, keep_ns_prefixes=None):
    """cleanup_namespaces(tree_or_element, top_nsmap=None, keep_ns_prefixes=None)

    Remove all namespace declarations from a subtree that are not used
    by any of the elements or attributes in that tree.

    If a 'top_nsmap' is provided, it must be a mapping from prefixes
    to namespace URIs.  These namespaces will be declared on the top
    element of the subtree before running the cleanup, which allows
    moving namespace declarations to the top of the tree.

    If a 'keep_ns_prefixes' is provided, it must be a list of prefixes.
    These prefixes will not be removed as part of the cleanup.
    """
    element = _rootNodeOrRaise(tree_or_element)
    c_element = element._c_node

    if top_nsmap:
        doc = element._doc
        # declare namespaces from nsmap, then apply them to the subtree
        _setNodeNamespaces(c_element, doc, None, top_nsmap)
        moveNodeToDocument(doc, c_element.doc, c_element)

    keep_ns_prefixes = (
        set([_utf8(prefix) for prefix in keep_ns_prefixes])
        if keep_ns_prefixes else None)

    _removeUnusedNamespaceDeclarations(c_element, keep_ns_prefixes)


def strip_attributes(tree_or_element, *attribute_names):
    """strip_attributes(tree_or_element, *attribute_names)

    Delete all attributes with the provided attribute names from an
    Element (or ElementTree) and its descendants.

    Attribute names can contain wildcards as in `_Element.iter`.

    Example usage::

        strip_attributes(root_element,
                         'simpleattr',
                         '{http://some/ns}attrname',
                         '{http://other/ns}*')
    """
    cdef _MultiTagMatcher matcher
    element = _rootNodeOrRaise(tree_or_element)
    if not attribute_names:
        return

    matcher = _MultiTagMatcher.__new__(_MultiTagMatcher, attribute_names)
    matcher.cacheTags(element._doc)
    if matcher.rejectsAllAttributes():
        return
    _strip_attributes(element._c_node, matcher)


cdef _strip_attributes(xmlNode* c_node, _MultiTagMatcher matcher):
    cdef xmlAttr* c_attr
    cdef xmlAttr* c_next_attr
    tree.BEGIN_FOR_EACH_ELEMENT_FROM(c_node, c_node, 1)
    if c_node.type == tree.XML_ELEMENT_NODE:
        c_attr = c_node.properties
        while c_attr is not NULL:
            c_next_attr = c_attr.next
            if matcher.matchesAttribute(c_attr):
                tree.xmlRemoveProp(c_attr)
            c_attr = c_next_attr
    tree.END_FOR_EACH_ELEMENT_FROM(c_node)


def strip_elements(tree_or_element, *tag_names, bint with_tail=True):
    """strip_elements(tree_or_element, *tag_names, with_tail=True)

    Delete all elements with the provided tag names from a tree or
    subtree.  This will remove the elements and their entire subtree,
    including all their attributes, text content and descendants.  It
    will also remove the tail text of the element unless you
    explicitly set the ``with_tail`` keyword argument option to False.

    Tag names can contain wildcards as in `_Element.iter`.

    Note that this will not delete the element (or ElementTree root
    element) that you passed even if it matches.  It will only treat
    its descendants.  If you want to include the root element, check
    its tag name directly before even calling this function.

    Example usage::

        strip_elements(some_element,
            'simpletagname',             # non-namespaced tag
            '{http://some/ns}tagname',   # namespaced tag
            '{http://some/other/ns}*'    # any tag from a namespace
            lxml.etree.Comment           # comments
            )
    """
    cdef _MultiTagMatcher matcher
    doc = _documentOrRaise(tree_or_element)
    element = _rootNodeOrRaise(tree_or_element)
    if not tag_names:
        return

    matcher = _MultiTagMatcher.__new__(_MultiTagMatcher, tag_names)
    matcher.cacheTags(doc)
    if matcher.rejectsAll():
        return

    if isinstance(tree_or_element, _ElementTree):
        # include PIs and comments next to the root node
        if matcher.matchesType(tree.XML_COMMENT_NODE):
            _removeSiblings(element._c_node, tree.XML_COMMENT_NODE, with_tail)
        if matcher.matchesType(tree.XML_PI_NODE):
            _removeSiblings(element._c_node, tree.XML_PI_NODE, with_tail)
    _strip_elements(doc, element._c_node, matcher, with_tail)

cdef _strip_elements(_Document doc, xmlNode* c_node, _MultiTagMatcher matcher,
                     bint with_tail):
    cdef xmlNode* c_child
    cdef xmlNode* c_next

    tree.BEGIN_FOR_EACH_ELEMENT_FROM(c_node, c_node, 1)
    if c_node.type == tree.XML_ELEMENT_NODE:
        # we run through the children here to prevent any problems
        # with the tree iteration which would occur if we unlinked the
        # c_node itself
        c_child = _findChildForwards(c_node, 0)
        while c_child is not NULL:
            c_next = _nextElement(c_child)
            if matcher.matches(c_child):
                if c_child.type == tree.XML_ELEMENT_NODE:
                    if not with_tail:
                        tree.xmlUnlinkNode(c_child)
                    _removeNode(doc, c_child)
                else:
                    if with_tail:
                        _removeText(c_child.next)
                    tree.xmlUnlinkNode(c_child)
                    attemptDeallocation(c_child)
            c_child = c_next
    tree.END_FOR_EACH_ELEMENT_FROM(c_node)


def strip_tags(tree_or_element, *tag_names):
    """strip_tags(tree_or_element, *tag_names)

    Delete all elements with the provided tag names from a tree or
    subtree.  This will remove the elements and their attributes, but
    *not* their text/tail content or descendants.  Instead, it will
    merge the text content and children of the element into its
    parent.

    Tag names can contain wildcards as in `_Element.iter`.

    Note that this will not delete the element (or ElementTree root
    element) that you passed even if it matches.  It will only treat
    its descendants.

    Example usage::

        strip_tags(some_element,
            'simpletagname',             # non-namespaced tag
            '{http://some/ns}tagname',   # namespaced tag
            '{http://some/other/ns}*'    # any tag from a namespace
            Comment                      # comments (including their text!)
            )
    """
    cdef _MultiTagMatcher matcher
    doc = _documentOrRaise(tree_or_element)
    element = _rootNodeOrRaise(tree_or_element)
    if not tag_names:
        return

    matcher = _MultiTagMatcher.__new__(_MultiTagMatcher, tag_names)
    matcher.cacheTags(doc)
    if matcher.rejectsAll():
        return

    if isinstance(tree_or_element, _ElementTree):
        # include PIs and comments next to the root node
        if matcher.matchesType(tree.XML_COMMENT_NODE):
            _removeSiblings(element._c_node, tree.XML_COMMENT_NODE, 0)
        if matcher.matchesType(tree.XML_PI_NODE):
            _removeSiblings(element._c_node, tree.XML_PI_NODE, 0)
    _strip_tags(doc, element._c_node, matcher)

cdef _strip_tags(_Document doc, xmlNode* c_node, _MultiTagMatcher matcher):
    cdef xmlNode* c_child
    cdef xmlNode* c_next

    tree.BEGIN_FOR_EACH_ELEMENT_FROM(c_node, c_node, 1)
    if c_node.type == tree.XML_ELEMENT_NODE:
        # we run through the children here to prevent any problems
        # with the tree iteration which would occur if we unlinked the
        # c_node itself
        c_child = _findChildForwards(c_node, 0)
        while c_child is not NULL:
            if not matcher.matches(c_child):
                c_child = _nextElement(c_child)
                continue
            if c_child.type == tree.XML_ELEMENT_NODE:
                c_next = _findChildForwards(c_child, 0) or _nextElement(c_child)
                _replaceNodeByChildren(doc, c_child)
                if not attemptDeallocation(c_child):
                    if c_child.nsDef is not NULL:
                        # make namespaces absolute
                        moveNodeToDocument(doc, doc._c_doc, c_child)
                c_child = c_next
            else:
                c_next = _nextElement(c_child)
                tree.xmlUnlinkNode(c_child)
                attemptDeallocation(c_child)
                c_child = c_next
    tree.END_FOR_EACH_ELEMENT_FROM(c_node)
