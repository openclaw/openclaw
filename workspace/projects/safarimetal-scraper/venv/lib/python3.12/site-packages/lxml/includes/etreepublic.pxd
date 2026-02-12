# public Cython/C interface to lxml.etree

from lxml.includes cimport tree
from lxml.includes.tree cimport const_xmlChar

cdef extern from "lxml-version.h":
    cdef char* LXML_VERSION_STRING

cdef extern from "etree_defs.h":
    # test if c_node is considered an Element (i.e. Element, Comment, etc.)
    cdef bint _isElement(tree.xmlNode* c_node) noexcept nogil

    # return the namespace URI of the node or NULL
    cdef const_xmlChar* _getNs(tree.xmlNode* node) noexcept nogil

    # pair of macros for tree traversal
    cdef void BEGIN_FOR_EACH_ELEMENT_FROM(tree.xmlNode* tree_top,
                                          tree.xmlNode* start_node,
                                          int start_node_inclusive) noexcept nogil
    cdef void END_FOR_EACH_ELEMENT_FROM(tree.xmlNode* start_node) noexcept nogil

cdef extern from "etree_api.h":

    # first function to call!
    cdef int import_lxml__etree() except -1

    ##########################################################################
    # public ElementTree API classes

    cdef class lxml.etree._Document [ object LxmlDocument ]:
        cdef tree.xmlDoc* _c_doc

    cdef class lxml.etree._Element [ object LxmlElement ]:
        cdef _Document _doc
        cdef tree.xmlNode* _c_node

    cdef class lxml.etree.ElementBase(_Element) [ object LxmlElementBase ]:
        pass

    cdef class lxml.etree._ElementTree [ object LxmlElementTree ]:
        cdef _Document _doc
        cdef _Element  _context_node

    cdef class lxml.etree.ElementClassLookup [ object LxmlElementClassLookup ]:
        cdef object (*_lookup_function)(object, _Document, tree.xmlNode*)

    cdef class lxml.etree.FallbackElementClassLookup(ElementClassLookup) \
             [ object LxmlFallbackElementClassLookup ]:
        cdef ElementClassLookup fallback
        cdef object (*_fallback_function)(object, _Document, tree.xmlNode*)

    ##########################################################################
    # creating Element objects

    # create an Element for a C-node in the Document
    cdef _Element elementFactory(_Document doc, tree.xmlNode* c_node)

    # create an ElementTree for an Element
    cdef _ElementTree elementTreeFactory(_Element context_node)

    # create an ElementTree subclass for an Element
    cdef _ElementTree newElementTree(_Element context_node, object subclass)

    # create an ElementTree from an external document
    cdef _ElementTree adoptExternalDocument(tree.xmlDoc* c_doc, parser, bint is_owned)

    # create a new Element for an existing or new document (doc = None)
    # builds Python object after setting text, tail, namespaces and attributes
    cdef _Element makeElement(tag, _Document doc, parser,
                              text, tail, attrib, nsmap)

    # create a new SubElement for an existing parent
    # builds Python object after setting text, tail, namespaces and attributes
    cdef _Element makeSubElement(_Element parent, tag, text, tail,
                                 attrib, nsmap)

    # deep copy a node to include it in the Document
    cdef _Element deepcopyNodeToDocument(_Document doc, tree.xmlNode* c_root)

    # set the internal lookup function for Element/Comment/PI classes
    # use setElementClassLookupFunction(NULL, None) to reset it
    # note that the lookup function *must always* return an _Element subclass!
    cdef void setElementClassLookupFunction(
         object (*function)(object, _Document, tree.xmlNode*), object state)

    # lookup function that always returns the default Element class
    # note that the first argument is expected to be None!
    cdef object lookupDefaultElementClass(_1, _Document _2,
                                          tree.xmlNode* c_node)

    # lookup function for namespace/tag specific Element classes
    # note that the first argument is expected to be None!
    cdef object lookupNamespaceElementClass(_1, _Document _2,
                                            tree.xmlNode* c_node)

    # call the fallback lookup function of a FallbackElementClassLookup
    cdef object callLookupFallback(FallbackElementClassLookup lookup,
                                   _Document doc, tree.xmlNode* c_node)

    ##########################################################################
    # XML attribute access

    # return an attribute value for a C attribute on a C element node
    cdef unicode attributeValue(tree.xmlNode* c_element,
                                tree.xmlAttr* c_attrib_node)

    # return the value of the attribute with 'ns' and 'name' (or None)
    cdef unicode attributeValueFromNsName(tree.xmlNode* c_element,
                                          const_xmlChar* c_ns, const_xmlChar* c_name)

    # return the value of attribute "{ns}name", or the default value
    cdef object getAttributeValue(_Element element, key, default)

    # return an iterator over attribute names (1), values (2) or items (3)
    # attributes must not be removed during iteration!
    cdef object iterattributes(_Element element, int keysvalues)

    # return the list of all attribute names (1), values (2) or items (3)
    cdef list collectAttributes(tree.xmlNode* c_element, int keysvalues)

    # set an attribute value on an element
    # on failure, sets an exception and returns -1
    cdef int setAttributeValue(_Element element, key, value) except -1

    # delete an attribute
    # on failure, sets an exception and returns -1
    cdef int delAttribute(_Element element, key) except -1

    # delete an attribute based on name and namespace URI
    # returns -1 if the attribute was not found (no exception)
    cdef int delAttributeFromNsName(tree.xmlNode* c_element,
                                    const_xmlChar* c_href, const_xmlChar* c_name) noexcept

    ##########################################################################
    # XML node helper functions

    # check if the element has at least one child
    cdef bint hasChild(tree.xmlNode* c_node) noexcept nogil

    # find child element number 'index' (supports negative indexes)
    cdef tree.xmlNode* findChild(tree.xmlNode* c_node,
                                 Py_ssize_t index) noexcept nogil

    # find child element number 'index' starting at first one
    cdef tree.xmlNode* findChildForwards(tree.xmlNode* c_node,
                                         Py_ssize_t index) nogil

    # find child element number 'index' starting at last one
    cdef tree.xmlNode* findChildBackwards(tree.xmlNode* c_node,
                                          Py_ssize_t index) nogil

    # return next/previous sibling element of the node
    cdef tree.xmlNode* nextElement(tree.xmlNode* c_node) nogil
    cdef tree.xmlNode* previousElement(tree.xmlNode* c_node) nogil

    ##########################################################################
    # iterators (DEPRECATED API, don't use in new code!)

    cdef class lxml.etree._ElementTagMatcher [ object LxmlElementTagMatcher ]:
        cdef char* _href
        cdef char* _name

    # store "{ns}tag" (or None) filter for this matcher or element iterator
    # ** unless _href *and* _name are set up 'by hand', this function *must*
    # ** be called when subclassing the iterator below!
    cdef void initTagMatch(_ElementTagMatcher matcher, tag)

    cdef class lxml.etree._ElementIterator(_ElementTagMatcher) [
        object LxmlElementIterator ]:
        cdef _Element _node
        cdef tree.xmlNode* (*_next_element)(tree.xmlNode*)

    # store the initial node of the iterator if it matches the required tag
    # or its next matching sibling if not
    cdef void iteratorStoreNext(_ElementIterator iterator, _Element node)

    ##########################################################################
    # other helper functions

    # check if a C node matches a tag name and namespace
    # (NULL allowed for each => always matches)
    cdef int tagMatches(tree.xmlNode* c_node, const_xmlChar* c_href, const_xmlChar* c_name)

    # convert a UTF-8 char* to a Python unicode string
    cdef unicode pyunicode(const_xmlChar* s)

    # convert the string to UTF-8 using the normal lxml.etree semantics
    cdef bytes utf8(object s)

    # split a tag into a (URI, name) tuple, return None as URI for '{}tag'
    cdef tuple getNsTag(object tag)

    # split a tag into a (URI, name) tuple, return b'' as URI for '{}tag'
    cdef tuple getNsTagWithEmptyNs(object tag)

    # get the "{ns}tag" string for a C node
    cdef unicode namespacedName(tree.xmlNode* c_node)

    # get the "{ns}tag" string for a href/tagname pair (c_ns may be NULL)
    cdef unicode namespacedNameFromNsName(const_xmlChar* c_ns, const_xmlChar* c_tag)

    # check if the node has a text value (which may be '')
    cdef bint hasText(tree.xmlNode* c_node) nogil

    # check if the node has a tail value (which may be '')
    cdef bint hasTail(tree.xmlNode* c_node) nogil

    # get the text content of an element (or None)
    cdef unicode textOf(tree.xmlNode* c_node)

    # get the tail content of an element (or None)
    cdef unicode tailOf(tree.xmlNode* c_node)

    # set the text value of an element
    cdef int setNodeText(tree.xmlNode* c_node, text) except -1

    # set the tail text value of an element
    cdef int setTailText(tree.xmlNode* c_node, text) except -1

    # append an element to the children of a parent element
    # deprecated: don't use, does not propagate exceptions!
    # use appendChildToElement() instead
    cdef void appendChild(_Element parent, _Element child)

    # added in lxml 3.3 as a safe replacement for appendChild()
    # return -1 for exception, 0 for ok
    cdef int appendChildToElement(_Element parent, _Element child) except -1

    # recursively lookup a namespace in element or ancestors, or create it
    cdef tree.xmlNs* findOrBuildNodeNsPrefix(
        _Document doc, tree.xmlNode* c_node, const_xmlChar* href, const_xmlChar* prefix)

    # find the Document of an Element, ElementTree or Document (itself!)
    cdef _Document documentOrRaise(object input)

    # find the root Element of an Element (itself!), ElementTree or Document
    cdef _Element rootNodeOrRaise(object input)
