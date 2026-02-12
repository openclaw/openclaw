# Configurable Element class lookup

################################################################################
# Custom Element classes

cdef public class ElementBase(_Element) [ type LxmlElementBaseType,
                                          object LxmlElementBase ]:
    """ElementBase(*children, attrib=None, nsmap=None, **_extra)

    The public Element class.  All custom Element classes must inherit
    from this one.  To create an Element, use the `Element()` factory.

    BIG FAT WARNING: Subclasses *must not* override __init__ or
    __new__ as it is absolutely undefined when these objects will be
    created or destroyed.  All persistent state of Elements must be
    stored in the underlying XML.  If you really need to initialize
    the object after creation, you can implement an ``_init(self)``
    method that will be called directly after object creation.

    Subclasses of this class can be instantiated to create a new
    Element.  By default, the tag name will be the class name and the
    namespace will be empty.  You can modify this with the following
    class attributes:

    * TAG - the tag name, possibly containing a namespace in Clark
      notation

    * NAMESPACE - the default namespace URI, unless provided as part
      of the TAG attribute.

    * HTML - flag if the class is an HTML tag, as opposed to an XML
      tag.  This only applies to un-namespaced tags and defaults to
      false (i.e. XML).

    * PARSER - the parser that provides the configuration for the
      newly created document.  Providing an HTML parser here will
      default to creating an HTML element.

    In user code, the latter three are commonly inherited in class
    hierarchies that implement a common namespace.
    """
    def __init__(self, *children, attrib=None, nsmap=None, **_extra):
        """ElementBase(*children, attrib=None, nsmap=None, **_extra)
        """
        cdef bint is_html = 0
        cdef _BaseParser parser
        cdef _Element last_child
        # don't use normal attribute access as it might be overridden
        _getattr = object.__getattribute__
        try:
            namespace = _utf8(_getattr(self, 'NAMESPACE'))
        except AttributeError:
            namespace = None
        try:
            ns, tag = _getNsTag(_getattr(self, 'TAG'))
            if ns is not None:
                namespace = ns
        except AttributeError:
            tag = _utf8(_getattr(_getattr(self, '__class__'), '__name__'))
            if b'.' in tag:
                tag = tag.split(b'.')[-1]
        try:
            parser = _getattr(self, 'PARSER')
        except AttributeError:
            parser = None
            for child in children:
                if isinstance(child, _Element):
                    parser = (<_Element>child)._doc._parser
                    break
        if isinstance(parser, HTMLParser):
            is_html = 1
        if namespace is None:
            try:
                is_html = _getattr(self, 'HTML')
            except AttributeError:
                pass
        _initNewElement(self, is_html, tag, namespace, parser,
                        attrib, nsmap, _extra)
        last_child = None
        for child in children:
            if _isString(child):
                if last_child is None:
                    _setNodeText(self._c_node,
                                 (_collectText(self._c_node.children) or '') + child)
                else:
                    _setTailText(last_child._c_node,
                                 (_collectText(last_child._c_node.next) or '') + child)
            elif isinstance(child, _Element):
                last_child = child
                _appendChild(self, last_child)
            elif isinstance(child, type) and issubclass(child, ElementBase):
                last_child = child()
                _appendChild(self, last_child)
            else:
                raise TypeError, f"Invalid child type: {type(child)!r}"

cdef class CommentBase(_Comment):
    """All custom Comment classes must inherit from this one.

    To create an XML Comment instance, use the ``Comment()`` factory.

    Subclasses *must not* override __init__ or __new__ as it is
    absolutely undefined when these objects will be created or
    destroyed.  All persistent state of Comments must be stored in the
    underlying XML.  If you really need to initialize the object after
    creation, you can implement an ``_init(self)`` method that will be
    called after object creation.
    """
    def __init__(self, text):
        # copied from Comment() factory
        cdef _Document doc
        cdef xmlDoc*   c_doc
        if text is None:
            text = b''
        else:
            text = _utf8(text)
        c_doc = _newXMLDoc()
        doc = _documentFactory(c_doc, None)
        self._c_node = _createComment(c_doc, _xcstr(text))
        if self._c_node is NULL:
            raise MemoryError()
        tree.xmlAddChild(<xmlNode*>c_doc, self._c_node)
        _registerProxy(self, doc, self._c_node)
        self._init()

cdef class PIBase(_ProcessingInstruction):
    """All custom Processing Instruction classes must inherit from this one.

    To create an XML ProcessingInstruction instance, use the ``PI()``
    factory.

    Subclasses *must not* override __init__ or __new__ as it is
    absolutely undefined when these objects will be created or
    destroyed.  All persistent state of PIs must be stored in the
    underlying XML.  If you really need to initialize the object after
    creation, you can implement an ``_init(self)`` method that will be
    called after object creation.
    """
    def __init__(self, target, text=None):
        # copied from PI() factory
        cdef _Document doc
        cdef xmlDoc*   c_doc
        target = _utf8(target)
        if text is None:
            text = b''
        else:
            text = _utf8(text)
        c_doc = _newXMLDoc()
        doc = _documentFactory(c_doc, None)
        self._c_node = _createPI(c_doc, _xcstr(target), _xcstr(text))
        if self._c_node is NULL:
            raise MemoryError()
        tree.xmlAddChild(<xmlNode*>c_doc, self._c_node)
        _registerProxy(self, doc, self._c_node)
        self._init()

cdef class EntityBase(_Entity):
    """All custom Entity classes must inherit from this one.

    To create an XML Entity instance, use the ``Entity()`` factory.

    Subclasses *must not* override __init__ or __new__ as it is
    absolutely undefined when these objects will be created or
    destroyed.  All persistent state of Entities must be stored in the
    underlying XML.  If you really need to initialize the object after
    creation, you can implement an ``_init(self)`` method that will be
    called after object creation.
    """
    def __init__(self, name):
        cdef _Document doc
        cdef xmlDoc*   c_doc
        name_utf = _utf8(name)
        c_name = _xcstr(name_utf)
        if c_name[0] == c'#':
            if not _characterReferenceIsValid(c_name + 1):
                raise ValueError, f"Invalid character reference: '{name}'"
        elif not _xmlNameIsValid(c_name):
            raise ValueError, f"Invalid entity reference: '{name}'"
        c_doc = _newXMLDoc()
        doc = _documentFactory(c_doc, None)
        self._c_node = _createEntity(c_doc, c_name)
        if self._c_node is NULL:
            raise MemoryError()
        tree.xmlAddChild(<xmlNode*>c_doc, self._c_node)
        _registerProxy(self, doc, self._c_node)
        self._init()


cdef int _validateNodeClass(xmlNode* c_node, cls) except -1:
    if c_node.type == tree.XML_ELEMENT_NODE:
        expected = ElementBase
    elif c_node.type == tree.XML_COMMENT_NODE:
        expected = CommentBase
    elif c_node.type == tree.XML_ENTITY_REF_NODE:
        expected = EntityBase
    elif c_node.type == tree.XML_PI_NODE:
        expected = PIBase
    else:
        assert False, f"Unknown node type: {c_node.type}"

    if not (isinstance(cls, type) and issubclass(cls, expected)):
        raise TypeError(
            f"result of class lookup must be subclass of {type(expected)}, got {type(cls)}")
    return 0


################################################################################
# Element class lookup

ctypedef public object (*_element_class_lookup_function)(object, _Document, xmlNode*)

# class to store element class lookup functions
cdef public class ElementClassLookup [ type LxmlElementClassLookupType,
                                       object LxmlElementClassLookup ]:
    """ElementClassLookup(self)
    Superclass of Element class lookups.
    """
    cdef _element_class_lookup_function _lookup_function


cdef public class FallbackElementClassLookup(ElementClassLookup) \
         [ type LxmlFallbackElementClassLookupType,
           object LxmlFallbackElementClassLookup ]:
    """FallbackElementClassLookup(self, fallback=None)

    Superclass of Element class lookups with additional fallback.
    """
    cdef readonly ElementClassLookup fallback
    cdef _element_class_lookup_function _fallback_function
    def __cinit__(self):
        # fall back to default lookup
        self._fallback_function = _lookupDefaultElementClass

    def __init__(self, ElementClassLookup fallback=None):
        if fallback is not None:
            self._setFallback(fallback)
        else:
            self._fallback_function = _lookupDefaultElementClass

    cdef void _setFallback(self, ElementClassLookup lookup):
        """Sets the fallback scheme for this lookup method.
        """
        self.fallback = lookup
        self._fallback_function = lookup._lookup_function
        if self._fallback_function is NULL:
            self._fallback_function = _lookupDefaultElementClass

    def set_fallback(self, ElementClassLookup lookup not None):
        """set_fallback(self, lookup)

        Sets the fallback scheme for this lookup method.
        """
        self._setFallback(lookup)

cdef inline object _callLookupFallback(FallbackElementClassLookup lookup,
                                       _Document doc, xmlNode* c_node):
    return lookup._fallback_function(lookup.fallback, doc, c_node)


################################################################################
# default lookup scheme

cdef class ElementDefaultClassLookup(ElementClassLookup):
    """ElementDefaultClassLookup(self, element=None, comment=None, pi=None, entity=None)
    Element class lookup scheme that always returns the default Element
    class.

    The keyword arguments ``element``, ``comment``, ``pi`` and ``entity``
    accept the respective Element classes.
    """
    cdef readonly object element_class
    cdef readonly object comment_class
    cdef readonly object pi_class
    cdef readonly object entity_class
    def __cinit__(self):
        self._lookup_function = _lookupDefaultElementClass

    def __init__(self, element=None, comment=None, pi=None, entity=None):
        if element is None:
            self.element_class = _Element
        elif issubclass(element, ElementBase):
            self.element_class = element
        else:
            raise TypeError, "element class must be subclass of ElementBase"

        if comment is None:
            self.comment_class = _Comment
        elif issubclass(comment, CommentBase):
            self.comment_class = comment
        else:
            raise TypeError, "comment class must be subclass of CommentBase"

        if entity is None:
            self.entity_class = _Entity
        elif issubclass(entity, EntityBase):
            self.entity_class = entity
        else:
            raise TypeError, "Entity class must be subclass of EntityBase"

        if pi is None:
            self.pi_class = None # special case, see below
        elif issubclass(pi, PIBase):
            self.pi_class = pi
        else:
            raise TypeError, "PI class must be subclass of PIBase"

cdef object _lookupDefaultElementClass(state, _Document _doc, xmlNode* c_node):
    "Trivial class lookup function that always returns the default class."
    if c_node.type == tree.XML_ELEMENT_NODE:
        if state is not None:
            return (<ElementDefaultClassLookup>state).element_class
        else:
            return _Element
    elif c_node.type == tree.XML_COMMENT_NODE:
        if state is not None:
            return (<ElementDefaultClassLookup>state).comment_class
        else:
            return _Comment
    elif c_node.type == tree.XML_ENTITY_REF_NODE:
        if state is not None:
            return (<ElementDefaultClassLookup>state).entity_class
        else:
            return _Entity
    elif c_node.type == tree.XML_PI_NODE:
        if state is None or (<ElementDefaultClassLookup>state).pi_class is None:
            # special case XSLT-PI
            if c_node.name is not NULL and c_node.content is not NULL:
                if tree.xmlStrcmp(c_node.name, <unsigned char*>"xml-stylesheet") == 0:
                    if tree.xmlStrstr(c_node.content, <unsigned char*>"text/xsl") is not NULL or \
                           tree.xmlStrstr(c_node.content, <unsigned char*>"text/xml") is not NULL:
                        return _XSLTProcessingInstruction
            return _ProcessingInstruction
        else:
            return (<ElementDefaultClassLookup>state).pi_class
    else:
        assert False, f"Unknown node type: {c_node.type}"


################################################################################
# attribute based lookup scheme

cdef class AttributeBasedElementClassLookup(FallbackElementClassLookup):
    """AttributeBasedElementClassLookup(self, attribute_name, class_mapping, fallback=None)
    Checks an attribute of an Element and looks up the value in a
    class dictionary.

    Arguments:
      - attribute name - '{ns}name' style string
      - class mapping  - Python dict mapping attribute values to Element classes
      - fallback       - optional fallback lookup mechanism

    A None key in the class mapping will be checked if the attribute is
    missing.
    """
    cdef object _class_mapping
    cdef tuple _pytag
    cdef const_xmlChar* _c_ns
    cdef const_xmlChar* _c_name
    def __cinit__(self):
        self._lookup_function = _attribute_class_lookup

    def __init__(self, attribute_name, class_mapping,
                 ElementClassLookup fallback=None):
        self._pytag = _getNsTag(attribute_name)
        ns, name = self._pytag
        if ns is None:
            self._c_ns = NULL
        else:
            self._c_ns = _xcstr(ns)
        self._c_name = _xcstr(name)
        self._class_mapping = dict(class_mapping)

        FallbackElementClassLookup.__init__(self, fallback)

cdef object _attribute_class_lookup(state, _Document doc, xmlNode* c_node):
    cdef AttributeBasedElementClassLookup lookup
    cdef python.PyObject* dict_result

    lookup = <AttributeBasedElementClassLookup>state
    if c_node.type == tree.XML_ELEMENT_NODE:
        value = _attributeValueFromNsName(
            c_node, lookup._c_ns, lookup._c_name)
        dict_result = python.PyDict_GetItem(lookup._class_mapping, value)
        if dict_result is not NULL:
            cls = <object>dict_result
            _validateNodeClass(c_node, cls)
            return cls
    return _callLookupFallback(lookup, doc, c_node)


################################################################################
#  per-parser lookup scheme

cdef class ParserBasedElementClassLookup(FallbackElementClassLookup):
    """ParserBasedElementClassLookup(self, fallback=None)
    Element class lookup based on the XML parser.
    """
    def __cinit__(self):
        self._lookup_function = _parser_class_lookup

cdef object _parser_class_lookup(state, _Document doc, xmlNode* c_node):
    if doc._parser._class_lookup is not None:
        return doc._parser._class_lookup._lookup_function(
            doc._parser._class_lookup, doc, c_node)
    return _callLookupFallback(<FallbackElementClassLookup>state, doc, c_node)


################################################################################
#  custom class lookup based on node type, namespace, name

cdef class CustomElementClassLookup(FallbackElementClassLookup):
    """CustomElementClassLookup(self, fallback=None)
    Element class lookup based on a subclass method.

    You can inherit from this class and override the method::

        lookup(self, type, doc, namespace, name)

    to lookup the element class for a node. Arguments of the method:
    * type:      one of 'element', 'comment', 'PI', 'entity'
    * doc:       document that the node is in
    * namespace: namespace URI of the node (or None for comments/PIs/entities)
    * name:      name of the element/entity, None for comments, target for PIs

    If you return None from this method, the fallback will be called.
    """
    def __cinit__(self):
        self._lookup_function = _custom_class_lookup

    def lookup(self, type, doc, namespace, name):
        "lookup(self, type, doc, namespace, name)"
        return None

cdef object _custom_class_lookup(state, _Document doc, xmlNode* c_node):
    cdef CustomElementClassLookup lookup

    lookup = <CustomElementClassLookup>state

    if c_node.type == tree.XML_ELEMENT_NODE:
        element_type = "element"
    elif c_node.type == tree.XML_COMMENT_NODE:
        element_type = "comment"
    elif c_node.type == tree.XML_PI_NODE:
        element_type = "PI"
    elif c_node.type == tree.XML_ENTITY_REF_NODE:
        element_type = "entity"
    else:
        element_type = "element"
    if c_node.name is NULL:
        name = None
    else:
        name = funicode(c_node.name)
    c_str = tree._getNs(c_node)
    ns = funicode(c_str) if c_str is not NULL else None

    cls = lookup.lookup(element_type, doc, ns, name)
    if cls is not None:
        _validateNodeClass(c_node, cls)
        return cls
    return _callLookupFallback(lookup, doc, c_node)


################################################################################
# read-only tree based class lookup

cdef class PythonElementClassLookup(FallbackElementClassLookup):
    """PythonElementClassLookup(self, fallback=None)
    Element class lookup based on a subclass method.

    This class lookup scheme allows access to the entire XML tree in
    read-only mode.  To use it, re-implement the ``lookup(self, doc,
    root)`` method in a subclass::

        from lxml import etree, pyclasslookup

        class MyElementClass(etree.ElementBase):
            honkey = True

        class MyLookup(pyclasslookup.PythonElementClassLookup):
            def lookup(self, doc, root):
                if root.tag == "sometag":
                    return MyElementClass
                else:
                    for child in root:
                        if child.tag == "someothertag":
                            return MyElementClass
                # delegate to default
                return None

    If you return None from this method, the fallback will be called.

    The first argument is the opaque document instance that contains
    the Element.  The second argument is a lightweight Element proxy
    implementation that is only valid during the lookup.  Do not try
    to keep a reference to it.  Once the lookup is done, the proxy
    will be invalid.

    Also, you cannot wrap such a read-only Element in an ElementTree,
    and you must take care not to keep a reference to them outside of
    the `lookup()` method.

    Note that the API of the Element objects is not complete.  It is
    purely read-only and does not support all features of the normal
    `lxml.etree` API (such as XPath, extended slicing or some
    iteration methods).

    See https://lxml.de/element_classes.html
    """
    def __cinit__(self):
        self._lookup_function = _python_class_lookup

    def lookup(self, doc, element):
        """lookup(self, doc, element)

        Override this method to implement your own lookup scheme.
        """
        return None

cdef object _python_class_lookup(state, _Document doc, tree.xmlNode* c_node):
    cdef PythonElementClassLookup lookup
    cdef _ReadOnlyProxy proxy
    lookup = <PythonElementClassLookup>state

    proxy = _newReadOnlyProxy(None, c_node)
    cls = lookup.lookup(doc, proxy)
    _freeReadOnlyProxies(proxy)

    if cls is not None:
        _validateNodeClass(c_node, cls)
        return cls
    return _callLookupFallback(lookup, doc, c_node)

################################################################################
# Global setup

cdef _element_class_lookup_function LOOKUP_ELEMENT_CLASS
cdef object ELEMENT_CLASS_LOOKUP_STATE

cdef void _setElementClassLookupFunction(
    _element_class_lookup_function function, object state):
    global LOOKUP_ELEMENT_CLASS, ELEMENT_CLASS_LOOKUP_STATE
    if function is NULL:
        state    = DEFAULT_ELEMENT_CLASS_LOOKUP
        function = DEFAULT_ELEMENT_CLASS_LOOKUP._lookup_function

    ELEMENT_CLASS_LOOKUP_STATE = state
    LOOKUP_ELEMENT_CLASS = function

def set_element_class_lookup(ElementClassLookup lookup = None):
    """set_element_class_lookup(lookup = None)

    Set the global element class lookup method.

    This defines the main entry point for looking up element implementations.
    The standard implementation uses the :class:`ParserBasedElementClassLookup`
    to delegate to different lookup schemes for each parser. 

    .. warning::

        This should only be changed by applications, not by library packages.
        In most cases, parser specific lookups should be preferred,
        which can be configured via
        :meth:`~lxml.etree.XMLParser.set_element_class_lookup`
        (and the same for HTML parsers).

        Globally replacing the element class lookup by something other than a
        :class:`ParserBasedElementClassLookup` will prevent parser specific lookup
        schemes from working. Several tools rely on parser specific lookups,
        including :mod:`lxml.html` and :mod:`lxml.objectify`.
    """
    if lookup is None or lookup._lookup_function is NULL:
        _setElementClassLookupFunction(NULL, None)
    else:
        _setElementClassLookupFunction(lookup._lookup_function, lookup)

# default setup: parser delegation
cdef ParserBasedElementClassLookup DEFAULT_ELEMENT_CLASS_LOOKUP
DEFAULT_ELEMENT_CLASS_LOOKUP = ParserBasedElementClassLookup()

set_element_class_lookup(DEFAULT_ELEMENT_CLASS_LOOKUP)
