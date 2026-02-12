# cython: binding=True
# cython: auto_pickle=False
# cython: language_level=3

"""
The ``lxml.objectify`` module implements a Python object API for XML.
It is based on `lxml.etree`.
"""

cimport cython

from lxml.includes.etreepublic cimport _Document, _Element, ElementBase, ElementClassLookup
from lxml.includes.etreepublic cimport elementFactory, import_lxml__etree, textOf, pyunicode
from lxml.includes.tree cimport const_xmlChar, _xcstr
from lxml cimport python
from lxml.includes cimport tree

cimport lxml.includes.etreepublic as cetree
cimport libc.string as cstring_h   # not to be confused with stdlib 'string'
from libc.string cimport const_char
from libc cimport limits

__all__ = ['BoolElement', 'DataElement', 'E', 'Element', 'ElementMaker',
           'FloatElement', 'IntElement', 'NoneElement',
           'NumberElement', 'ObjectPath', 'ObjectifiedDataElement',
           'ObjectifiedElement', 'ObjectifyElementClassLookup',
           'PYTYPE_ATTRIBUTE', 'PyType', 'StringElement', 'SubElement',
           'XML', 'annotate', 'deannotate', 'dump', 'enable_recursive_str',
           'fromstring', 'getRegisteredTypes', 'makeparser', 'parse',
           'pyannotate', 'pytypename', 'set_default_parser',
           'set_pytype_attribute_tag', 'xsiannotate']

cdef object etree
from lxml import etree
# initialize C-API of lxml.etree
import_lxml__etree()

__version__ = etree.__version__

cdef object _float_is_inf, _float_is_nan
from math import isinf as _float_is_inf, isnan as _float_is_nan

cdef object re
import re

cdef tuple IGNORABLE_ERRORS = (ValueError, TypeError)
cdef object is_special_method = re.compile('__.*__$').match


cdef object _typename(object t):
    cdef const_char* c_name
    c_name = python._fqtypename(t)
    s = cstring_h.strrchr(c_name, c'.')
    if s is not NULL:
        c_name = s + 1
    return pyunicode(<const_xmlChar*>c_name)


# namespace/name for "pytype" hint attribute
cdef object PYTYPE_NAMESPACE
cdef bytes PYTYPE_NAMESPACE_UTF8
cdef const_xmlChar* _PYTYPE_NAMESPACE

cdef object PYTYPE_ATTRIBUTE_NAME
cdef bytes PYTYPE_ATTRIBUTE_NAME_UTF8
cdef const_xmlChar* _PYTYPE_ATTRIBUTE_NAME

PYTYPE_ATTRIBUTE = None

cdef unicode TREE_PYTYPE_NAME = "TREE"

cdef tuple _unicodeAndUtf8(s):
    return s, python.PyUnicode_AsUTF8String(s)

def set_pytype_attribute_tag(attribute_tag=None):
    """set_pytype_attribute_tag(attribute_tag=None)
    Change name and namespace of the XML attribute that holds Python type
    information.

    Do not use this unless you know what you are doing.

    Reset by calling without argument.

    Default: "{http://codespeak.net/lxml/objectify/pytype}pytype"
    """
    global PYTYPE_ATTRIBUTE, _PYTYPE_NAMESPACE, _PYTYPE_ATTRIBUTE_NAME
    global PYTYPE_NAMESPACE, PYTYPE_NAMESPACE_UTF8
    global PYTYPE_ATTRIBUTE_NAME, PYTYPE_ATTRIBUTE_NAME_UTF8
    if attribute_tag is None:
        PYTYPE_NAMESPACE, PYTYPE_NAMESPACE_UTF8 = \
            _unicodeAndUtf8("http://codespeak.net/lxml/objectify/pytype")
        PYTYPE_ATTRIBUTE_NAME, PYTYPE_ATTRIBUTE_NAME_UTF8 = \
            _unicodeAndUtf8("pytype")
    else:
        PYTYPE_NAMESPACE_UTF8, PYTYPE_ATTRIBUTE_NAME_UTF8 = \
            cetree.getNsTag(attribute_tag)
        PYTYPE_NAMESPACE = PYTYPE_NAMESPACE_UTF8.decode('utf8')
        PYTYPE_ATTRIBUTE_NAME = PYTYPE_ATTRIBUTE_NAME_UTF8.decode('utf8')

    _PYTYPE_NAMESPACE      = PYTYPE_NAMESPACE_UTF8
    _PYTYPE_ATTRIBUTE_NAME = PYTYPE_ATTRIBUTE_NAME_UTF8
    PYTYPE_ATTRIBUTE = cetree.namespacedNameFromNsName(
        _PYTYPE_NAMESPACE, _PYTYPE_ATTRIBUTE_NAME)

set_pytype_attribute_tag()


# namespaces for XML Schema
cdef object XML_SCHEMA_NS, XML_SCHEMA_NS_UTF8
XML_SCHEMA_NS, XML_SCHEMA_NS_UTF8 = \
    _unicodeAndUtf8("http://www.w3.org/2001/XMLSchema")
cdef const_xmlChar* _XML_SCHEMA_NS = _xcstr(XML_SCHEMA_NS_UTF8)

cdef object XML_SCHEMA_INSTANCE_NS, XML_SCHEMA_INSTANCE_NS_UTF8
XML_SCHEMA_INSTANCE_NS, XML_SCHEMA_INSTANCE_NS_UTF8 = \
    _unicodeAndUtf8("http://www.w3.org/2001/XMLSchema-instance")
cdef const_xmlChar* _XML_SCHEMA_INSTANCE_NS = _xcstr(XML_SCHEMA_INSTANCE_NS_UTF8)

cdef object XML_SCHEMA_INSTANCE_NIL_ATTR = "{%s}nil" % XML_SCHEMA_INSTANCE_NS
cdef object XML_SCHEMA_INSTANCE_TYPE_ATTR = "{%s}type" % XML_SCHEMA_INSTANCE_NS


################################################################################
# Element class for the main API

cdef class ObjectifiedElement(ElementBase):
    """Main XML Element class.

    Element children are accessed as object attributes.  Multiple children
    with the same name are available through a list index.  Example::

       >>> root = XML("<root><c1><c2>0</c2><c2>1</c2></c1></root>")
       >>> second_c2 = root.c1.c2[1]
       >>> print(second_c2.text)
       1

    Note that you cannot (and must not) instantiate this class or its
    subclasses.
    """
    def __iter__(self):
        """Iterate over self and all siblings with the same tag.
        """
        parent = self.getparent()
        if parent is None:
            return iter([self])
        return etree.ElementChildIterator(parent, tag=self.tag)

    def __str__(self):
        if __RECURSIVE_STR:
            return _dump(self, 0)
        else:
            return textOf(self._c_node) or ''

    # pickle support for objectified Element
    def __reduce__(self):
        return fromstring, (etree.tostring(self),)

    @property
    def text(self):
        return textOf(self._c_node)

    @property
    def __dict__(self):
        """A fake implementation for __dict__ to support dir() etc.

        Note that this only considers the first child with a given name.
        """
        cdef _Element child
        cdef dict children
        c_ns = tree._getNs(self._c_node)
        tag = "{%s}*" % pyunicode(c_ns) if c_ns is not NULL else None
        children = {}
        for child in etree.ElementChildIterator(self, tag=tag):
            if c_ns is NULL and tree._getNs(child._c_node) is not NULL:
                continue
            name = pyunicode(child._c_node.name)
            if name not in children:
                children[name] = child
        return children

    def __len__(self):
        """Count self and siblings with the same tag.
        """
        return _countSiblings(self._c_node)

    def countchildren(self):
        """countchildren(self)

        Return the number of children of this element, regardless of their
        name.
        """
        # copied from etree
        cdef Py_ssize_t c
        cdef tree.xmlNode* c_node
        c = 0
        c_node = self._c_node.children
        while c_node is not NULL:
            if tree._isElement(c_node):
                c += 1
            c_node = c_node.next
        return c

    def getchildren(self):
        """getchildren(self)

        Returns a sequence of all direct children.  The elements are
        returned in document order.
        """
        cdef tree.xmlNode* c_node
        result = []
        c_node = self._c_node.children
        while c_node is not NULL:
            if tree._isElement(c_node):
                result.append(cetree.elementFactory(self._doc, c_node))
            c_node = c_node.next
        return result

    def __getattr__(self, tag):
        """Return the (first) child with the given tag name.  If no namespace
        is provided, the child will be looked up in the same one as self.
        """
        return _lookupChildOrRaise(self, tag)

    def __setattr__(self, tag, value):
        """Set the value of the (first) child with the given tag name.  If no
        namespace is provided, the child will be looked up in the same one as
        self.
        """
        cdef _Element element
        # properties are looked up /after/ __setattr__, so we must emulate them
        if tag == 'text' or tag == 'pyval':
            # read-only !
            raise TypeError, f"attribute '{tag}' of '{_typename(self)}' objects is not writable"
        elif tag == 'tail':
            cetree.setTailText(self._c_node, value)
            return
        elif tag == 'tag':
            ElementBase.tag.__set__(self, value)
            return
        elif tag == 'base':
            ElementBase.base.__set__(self, value)
            return
        tag = _buildChildTag(self, tag)
        element = _lookupChild(self, tag)
        if element is None:
            _appendValue(self, tag, value)
        else:
            _replaceElement(element, value)

    def __delattr__(self, tag):
        child = _lookupChildOrRaise(self, tag)
        self.remove(child)

    def addattr(self, tag, value):
        """addattr(self, tag, value)

        Add a child value to the element.

        As opposed to append(), it sets a data value, not an element.
        """
        _appendValue(self, _buildChildTag(self, tag), value)

    def __getitem__(self, key):
        """Return a sibling, counting from the first child of the parent.  The
        method behaves like both a dict and a sequence.

        * If argument is an integer, returns the sibling at that position.

        * If argument is a string, does the same as getattr().  This can be
          used to provide namespaces for element lookup, or to look up
          children with special names (``text`` etc.).

        * If argument is a slice object, returns the matching slice.
        """
        cdef tree.xmlNode* c_self_node
        cdef tree.xmlNode* c_parent
        cdef tree.xmlNode* c_node
        cdef Py_ssize_t c_index
        if python._isString(key):
            return _lookupChildOrRaise(self, key)
        elif isinstance(key, slice):
            return list(self)[key]
        # normal item access
        c_index = key   # raises TypeError if necessary
        c_self_node = self._c_node
        c_parent = c_self_node.parent
        if c_parent is NULL:
            if c_index == 0 or c_index == -1:
                return self
            raise IndexError, unicode(key)
        if c_index < 0:
            c_node = c_parent.last
        else:
            c_node = c_parent.children
        c_node = _findFollowingSibling(
            c_node, tree._getNs(c_self_node), c_self_node.name, c_index)
        if c_node is NULL:
            raise IndexError, unicode(key)
        return elementFactory(self._doc, c_node)

    def __setitem__(self, key, value):
        """Set the value of a sibling, counting from the first child of the
        parent.  Implements key assignment, item assignment and slice
        assignment.

        * If argument is an integer, sets the sibling at that position.

        * If argument is a string, does the same as setattr().  This is used
          to provide namespaces for element lookup.

        * If argument is a sequence (list, tuple, etc.), assign the contained
          items to the siblings.
        """
        cdef _Element element
        cdef tree.xmlNode* c_node
        if python._isString(key):
            key = _buildChildTag(self, key)
            element = _lookupChild(self, key)
            if element is None:
                _appendValue(self, key, value)
            else:
                _replaceElement(element, value)
            return

        if self._c_node.parent is NULL:
            # the 'root[i] = ...' case
            raise TypeError, "assignment to root element is invalid"

        if isinstance(key, slice):
            # slice assignment
            _setSlice(key, self, value)
        else:
            # normal index assignment
            if key < 0:
                c_node = self._c_node.parent.last
            else:
                c_node = self._c_node.parent.children
            c_node = _findFollowingSibling(
                c_node, tree._getNs(self._c_node), self._c_node.name, key)
            if c_node is NULL:
                raise IndexError, unicode(key)
            element = elementFactory(self._doc, c_node)
            _replaceElement(element, value)

    def __delitem__(self, key):
        parent = self.getparent()
        if parent is None:
            raise TypeError, "deleting items not supported by root element"
        if isinstance(key, slice):
            # slice deletion
            del_items = list(self)[key]
            remove = parent.remove
            for el in del_items:
                remove(el)
        else:
            # normal index deletion
            sibling = self.__getitem__(key)
            parent.remove(sibling)

    def descendantpaths(self, prefix=None):
        """descendantpaths(self, prefix=None)

        Returns a list of object path expressions for all descendants.
        """
        if prefix is not None and not python._isString(prefix):
            prefix = '.'.join(prefix)
        return _build_descendant_paths(self._c_node, prefix)


cdef inline bint _tagMatches(tree.xmlNode* c_node, const_xmlChar* c_href, const_xmlChar* c_name):
    if c_node.name != c_name:
        return 0
    if c_href == NULL:
        return 1
    c_node_href = tree._getNs(c_node)
    if c_node_href == NULL:
        return c_href[0] == c'\0'
    return tree.xmlStrcmp(c_node_href, c_href) == 0


cdef Py_ssize_t _countSiblings(tree.xmlNode* c_start_node):
    cdef tree.xmlNode* c_node
    cdef Py_ssize_t count
    c_tag  = c_start_node.name
    c_href = tree._getNs(c_start_node)
    count = 1
    c_node = c_start_node.next
    while c_node is not NULL:
        if c_node.type == tree.XML_ELEMENT_NODE and \
               _tagMatches(c_node, c_href, c_tag):
            count += 1
        c_node = c_node.next
    c_node = c_start_node.prev
    while c_node is not NULL:
        if c_node.type == tree.XML_ELEMENT_NODE and \
               _tagMatches(c_node, c_href, c_tag):
            count += 1
        c_node = c_node.prev
    return count

cdef tree.xmlNode* _findFollowingSibling(tree.xmlNode* c_node,
                                         const_xmlChar* href, const_xmlChar* name,
                                         Py_ssize_t index):
    cdef tree.xmlNode* (*next)(tree.xmlNode*)
    if index >= 0:
        next = cetree.nextElement
    else:
        index = -1 - index
        next = cetree.previousElement
    while c_node is not NULL:
        if c_node.type == tree.XML_ELEMENT_NODE and \
               _tagMatches(c_node, href, name):
            index = index - 1
            if index < 0:
                return c_node
        c_node = next(c_node)
    return NULL

cdef object _lookupChild(_Element parent, tag):
    cdef tree.xmlNode* c_result
    cdef tree.xmlNode* c_node
    c_node = parent._c_node
    ns, tag = cetree.getNsTagWithEmptyNs(tag)
    c_tag_len = len(<bytes> tag)
    if c_tag_len > limits.INT_MAX:
        return None
    c_tag = tree.xmlDictExists(
        c_node.doc.dict, _xcstr(tag), <int> c_tag_len)
    if c_tag is NULL:
        return None # not in the hash map => not in the tree
    if ns is None:
        # either inherit ns from parent or use empty (i.e. no) namespace
        c_href = tree._getNs(c_node) or <const_xmlChar*>''
    else:
        c_href = _xcstr(ns)
    c_result = _findFollowingSibling(c_node.children, c_href, c_tag, 0)
    if c_result is NULL:
        return None
    return elementFactory(parent._doc, c_result)

cdef object _lookupChildOrRaise(_Element parent, tag):
    element = _lookupChild(parent, tag)
    if element is None:
        raise AttributeError, "no such child: " + _buildChildTag(parent, tag)
    return element

cdef object _buildChildTag(_Element parent, tag):
    ns, tag = cetree.getNsTag(tag)
    c_tag = _xcstr(tag)
    c_href = tree._getNs(parent._c_node) if ns is None else _xcstr(ns)
    return cetree.namespacedNameFromNsName(c_href, c_tag)

cdef _replaceElement(_Element element, value):
    cdef _Element new_element
    if isinstance(value, _Element):
        # deep copy the new element
        new_element = cetree.deepcopyNodeToDocument(
            element._doc, (<_Element>value)._c_node)
        new_element.tag = element.tag
    elif isinstance(value, (list, tuple)):
        element[:] = value
        return
    else:
        new_element = element.makeelement(element.tag)
        _setElementValue(new_element, value)
    element.getparent().replace(element, new_element)

cdef _appendValue(_Element parent, tag, value):
    cdef _Element new_element
    if isinstance(value, _Element):
        # deep copy the new element
        new_element = cetree.deepcopyNodeToDocument(
            parent._doc, (<_Element>value)._c_node)
        new_element.tag = tag
        cetree.appendChildToElement(parent, new_element)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _appendValue(parent, tag, item)
    else:
        new_element = cetree.makeElement(
            tag, parent._doc, None, None, None, None, None)
        _setElementValue(new_element, value)
        cetree.appendChildToElement(parent, new_element)

cdef _setElementValue(_Element element, value):
    if value is None:
        cetree.setAttributeValue(
            element, XML_SCHEMA_INSTANCE_NIL_ATTR, "true")
    elif isinstance(value, _Element):
        _replaceElement(element, value)
        return
    else:
        cetree.delAttributeFromNsName(
            element._c_node, _XML_SCHEMA_INSTANCE_NS, <unsigned char*>"nil")
        if python._isString(value):
            pytype_name = "str"
            py_type = <PyType>_PYTYPE_DICT.get(pytype_name)
        else:
            pytype_name = _typename(value)
            py_type = <PyType>_PYTYPE_DICT.get(pytype_name)
            if py_type is not None:
                value = py_type.stringify(value)
            else:
                value = unicode(value)
        if py_type is not None:
            cetree.setAttributeValue(element, PYTYPE_ATTRIBUTE, pytype_name)
        else:
            cetree.delAttributeFromNsName(
                element._c_node, _PYTYPE_NAMESPACE, _PYTYPE_ATTRIBUTE_NAME)
    cetree.setNodeText(element._c_node, value)

cdef _setSlice(sliceobject, _Element target, items):
    cdef _Element parent
    cdef tree.xmlNode* c_node
    cdef Py_ssize_t c_step, c_start, pos
    # collect existing slice
    if (<slice>sliceobject).step is None:
        c_step = 1
    else:
        c_step = (<slice>sliceobject).step
    if c_step == 0:
        raise ValueError, "Invalid slice"
    cdef list del_items = target[sliceobject]

    # collect new values
    new_items = []
    tag = target.tag
    for item in items:
        if isinstance(item, _Element):
            # deep copy the new element
            new_element = cetree.deepcopyNodeToDocument(
                target._doc, (<_Element>item)._c_node)
            new_element.tag = tag
        else:
            new_element = cetree.makeElement(
                tag, target._doc, None, None, None, None, None)
            _setElementValue(new_element, item)
        new_items.append(new_element)

    # sanity check - raise what a list would raise
    if c_step != 1 and len(del_items) != len(new_items):
        raise ValueError, \
            f"attempt to assign sequence of size {len(new_items)} to extended slice of size {len(del_items)}"

    # replace existing items
    pos = 0
    parent = target.getparent()
    replace = parent.replace
    while pos < len(new_items) and pos < len(del_items):
        replace(del_items[pos], new_items[pos])
        pos += 1
    # remove leftover items
    if pos < len(del_items):
        remove = parent.remove
        while pos < len(del_items):
            remove(del_items[pos])
            pos += 1
    # append remaining new items
    if pos < len(new_items):
        # the sanity check above guarantees (step == 1)
        if pos > 0:
            item = new_items[pos-1]
        else:
            if (<slice>sliceobject).start > 0:
                c_node = parent._c_node.children
            else:
                c_node = parent._c_node.last
            c_node = _findFollowingSibling(
                c_node, tree._getNs(target._c_node), target._c_node.name,
                (<slice>sliceobject).start - 1)
            if c_node is NULL:
                while pos < len(new_items):
                    cetree.appendChildToElement(parent, new_items[pos])
                    pos += 1
                return
            item = cetree.elementFactory(parent._doc, c_node)
        while pos < len(new_items):
            add = item.addnext
            item = new_items[pos]
            add(item)
            pos += 1

################################################################################
# Data type support in subclasses

cdef class ObjectifiedDataElement(ObjectifiedElement):
    """This is the base class for all data type Elements.  Subclasses should
    override the 'pyval' property and possibly the __str__ method.
    """
    @property
    def pyval(self):
        return textOf(self._c_node)

    def __str__(self):
        return textOf(self._c_node) or ''

    def __repr__(self):
        return textOf(self._c_node) or ''

    def _setText(self, s):
        """For use in subclasses only. Don't use unless you know what you are
        doing.
        """
        cetree.setNodeText(self._c_node, s)


cdef class NumberElement(ObjectifiedDataElement):
    cdef object _parse_value

    def _setValueParser(self, function):
        """Set the function that parses the Python value from a string.

        Do not use this unless you know what you are doing.
        """
        self._parse_value = function

    @property
    def pyval(self):
        return _parseNumber(self)

    def __int__(self):
        return int(_parseNumber(self))

    def __float__(self):
        return float(_parseNumber(self))

    def __complex__(self):
        return complex(_parseNumber(self))

    def __str__(self):
        return unicode(_parseNumber(self))

    def __repr__(self):
        return repr(_parseNumber(self))

    def __oct__(self):
        return oct(_parseNumber(self))

    def __hex__(self):
        return hex(_parseNumber(self))

    def __richcmp__(self, other, int op):
        return _richcmpPyvals(self, other, op)

    def __hash__(self):
        return hash(_parseNumber(self))

    def __add__(self, other):
        return _numericValueOf(self) + _numericValueOf(other)

    def __radd__(self, other):
        return _numericValueOf(other) + _numericValueOf(self)

    def __sub__(self, other):
        return _numericValueOf(self) - _numericValueOf(other)

    def __rsub__(self, other):
        return _numericValueOf(other) - _numericValueOf(self)

    def __mul__(self, other):
        return _numericValueOf(self) * _numericValueOf(other)

    def __rmul__(self, other):
        return _numericValueOf(other) * _numericValueOf(self)

    def __div__(self, other):
        return _numericValueOf(self) / _numericValueOf(other)

    def __rdiv__(self, other):
        return _numericValueOf(other) / _numericValueOf(self)

    def __truediv__(self, other):
        return _numericValueOf(self) / _numericValueOf(other)

    def __rtruediv__(self, other):
        return _numericValueOf(other) / _numericValueOf(self)

    def __floordiv__(self, other):
        return _numericValueOf(self) // _numericValueOf(other)

    def __rfloordiv__(self, other):
        return _numericValueOf(other) // _numericValueOf(self)

    def __mod__(self, other):
        return _numericValueOf(self) % _numericValueOf(other)

    def __rmod__(self, other):
        return _numericValueOf(other) % _numericValueOf(self)

    def __divmod__(self, other):
        return divmod(_numericValueOf(self), _numericValueOf(other))

    def __rdivmod__(self, other):
        return divmod(_numericValueOf(other), _numericValueOf(self))

    def __pow__(self, other, modulo):
        if modulo is None:
            return _numericValueOf(self) ** _numericValueOf(other)
        else:
            return pow(_numericValueOf(self), _numericValueOf(other), modulo)

    def __rpow__(self, other, modulo):
        if modulo is None:
            return _numericValueOf(other) ** _numericValueOf(self)
        else:
            return pow(_numericValueOf(other), _numericValueOf(self), modulo)

    def __neg__(self):
        return - _numericValueOf(self)

    def __pos__(self):
        return + _numericValueOf(self)

    def __abs__(self):
        return abs( _numericValueOf(self) )

    def __bool__(self):
        return bool(_numericValueOf(self))

    def __invert__(self):
        return ~ _numericValueOf(self)

    def __lshift__(self, other):
        return _numericValueOf(self) << _numericValueOf(other)

    def __rlshift__(self, other):
        return _numericValueOf(other) << _numericValueOf(self)

    def __rshift__(self, other):
        return _numericValueOf(self) >> _numericValueOf(other)

    def __rrshift__(self, other):
        return _numericValueOf(other) >> _numericValueOf(self)

    def __and__(self, other):
        return _numericValueOf(self) & _numericValueOf(other)

    def __rand__(self, other):
        return _numericValueOf(other) & _numericValueOf(self)

    def __or__(self, other):
        return _numericValueOf(self) | _numericValueOf(other)

    def __ror__(self, other):
        return _numericValueOf(other) | _numericValueOf(self)

    def __xor__(self, other):
        return _numericValueOf(self) ^ _numericValueOf(other)

    def __rxor__(self, other):
        return _numericValueOf(other) ^ _numericValueOf(self)


cdef class IntElement(NumberElement):
    def _init(self):
        self._parse_value = int

    def __index__(self):
        return int(_parseNumber(self))


cdef class FloatElement(NumberElement):
    def _init(self):
        self._parse_value = float


cdef class StringElement(ObjectifiedDataElement):
    """String data class.

    Note that this class does *not* support the sequence protocol of strings:
    len(), iter(), str_attr[0], str_attr[0:1], etc. are *not* supported.
    Instead, use the .text attribute to get a 'real' string.
    """
    @property
    def pyval(self):
        return textOf(self._c_node) or ''

    def __repr__(self):
        return repr(textOf(self._c_node) or '')

    def strlen(self):
        text = textOf(self._c_node)
        if text is None:
            return 0
        else:
            return len(text)

    def __bool__(self):
        return bool(textOf(self._c_node))

    def __richcmp__(self, other, int op):
        return _richcmpPyvals(self, other, op)

    def __hash__(self):
        return hash(textOf(self._c_node) or '')

    def __add__(self, other):
        text  = _strValueOf(self)
        other = _strValueOf(other)
        return text + other

    def __radd__(self, other):
        text  = _strValueOf(self)
        other = _strValueOf(other)
        return other + text

    def __mul__(self, other):
        if isinstance(self, StringElement):
            return (textOf((<StringElement>self)._c_node) or '') * _numericValueOf(other)
        elif isinstance(other, StringElement):
            return _numericValueOf(self) * (textOf((<StringElement>other)._c_node) or '')
        else:
            return NotImplemented

    def __rmul__(self, other):
        return _numericValueOf(other) * (textOf((<StringElement>self)._c_node) or '')

    def __mod__(self, other):
        return (_strValueOf(self) or '') % other

    def __int__(self):
        return int(textOf(self._c_node))

    def __float__(self):
        return float(textOf(self._c_node))

    def __complex__(self):
        return complex(textOf(self._c_node))


cdef class NoneElement(ObjectifiedDataElement):
    def __str__(self):
        return "None"

    def __repr__(self):
        return "None"

    def __bool__(self):
        return False

    def __richcmp__(self, other, int op):
        if other is None or self is None:
            return python.PyObject_RichCompare(None, None, op)
        if isinstance(self, NoneElement):
            return python.PyObject_RichCompare(None, other, op)
        else:
            return python.PyObject_RichCompare(self, None, op)

    def __hash__(self):
        return hash(None)

    @property
    def pyval(self):
        return None


cdef class BoolElement(IntElement):
    """Boolean type base on string values: 'true' or 'false'.

    Note that this inherits from IntElement to mimic the behaviour of
    Python's bool type.
    """
    def _init(self):
        self._parse_value = _parseBool  # wraps as Python callable

    def __bool__(self):
        return _parseBool(textOf(self._c_node))

    def __int__(self):
        return 0 + _parseBool(textOf(self._c_node))

    def __float__(self):
        return 0.0 + _parseBool(textOf(self._c_node))

    def __richcmp__(self, other, int op):
        return _richcmpPyvals(self, other, op)

    def __hash__(self):
        return hash(_parseBool(textOf(self._c_node)))

    def __str__(self):
        return unicode(_parseBool(textOf(self._c_node)))

    def __repr__(self):
        return repr(_parseBool(textOf(self._c_node)))

    @property
    def pyval(self):
        return _parseBool(textOf(self._c_node))


cdef _checkBool(s):
    cdef int value = -1
    if s is not None:
        value = __parseBoolAsInt(s)
    if value == -1:
        raise ValueError


cdef bint _parseBool(s) except -1:
    cdef int value
    if s is None:
        return False
    value = __parseBoolAsInt(s)
    if value == -1:
        raise ValueError, f"Invalid boolean value: '{s}'"
    return value


cdef inline int __parseBoolAsInt(text) except -2:
    if text == 'false':
        return 0
    elif text == 'true':
        return 1
    elif text == '0':
        return 0
    elif text == '1':
        return 1
    return -1


cdef object _parseNumber(NumberElement element):
    return element._parse_value(textOf(element._c_node))


cdef enum NumberParserState:
    NPS_SPACE_PRE = 0
    NPS_SIGN = 1
    NPS_DIGITS = 2
    NPS_POINT_LEAD = 3
    NPS_POINT = 4
    NPS_FRACTION = 5
    NPS_EXP = 6
    NPS_EXP_SIGN = 7
    NPS_DIGITS_EXP = 8
    NPS_SPACE_TAIL = 9
    NPS_INF1 = 20
    NPS_INF2 = 21
    NPS_INF3 = 22
    NPS_NAN1 = 23
    NPS_NAN2 = 24
    NPS_NAN3 = 25
    NPS_ERROR = 99


ctypedef fused bytes_unicode:
    bytes
    unicode


cdef _checkNumber(bytes_unicode s, bint allow_float):
    cdef Py_UCS4 c
    cdef NumberParserState state = NPS_SPACE_PRE

    for c in s:
        if c in '0123456789':
            if state in (NPS_DIGITS, NPS_FRACTION, NPS_DIGITS_EXP):
                pass
            elif state in (NPS_SPACE_PRE, NPS_SIGN):
                state = NPS_DIGITS
            elif state in (NPS_POINT_LEAD, NPS_POINT):
                state = NPS_FRACTION
            elif state in (NPS_EXP, NPS_EXP_SIGN):
                state = NPS_DIGITS_EXP
            else:
                state = NPS_ERROR
        else:
            if c == '.':
                if state in (NPS_SPACE_PRE, NPS_SIGN):
                    state = NPS_POINT_LEAD
                elif state == NPS_DIGITS:
                    state = NPS_POINT
                else:
                    state = NPS_ERROR
                if not allow_float:
                    state = NPS_ERROR
            elif c in '-+':
                if state == NPS_SPACE_PRE:
                    state = NPS_SIGN
                elif state == NPS_EXP:
                    state = NPS_EXP_SIGN
                else:
                    state = NPS_ERROR
            elif c == 'E':
                if state in (NPS_DIGITS, NPS_POINT, NPS_FRACTION):
                    state = NPS_EXP
                else:
                    state = NPS_ERROR
                if not allow_float:
                    state = NPS_ERROR
            # Allow INF and NaN. XMLSchema requires case, we don't, like Python.
            elif c in 'iI':
                state = NPS_INF1 if allow_float and state in (NPS_SPACE_PRE, NPS_SIGN) else NPS_ERROR
            elif c in 'fF':
                state = NPS_INF3 if state == NPS_INF2 else NPS_ERROR
            elif c in 'aA':
                state = NPS_NAN2 if state == NPS_NAN1 else NPS_ERROR
            elif c in 'nN':
                # Python also allows [+-]NaN, so let's accept that.
                if state in (NPS_SPACE_PRE, NPS_SIGN):
                    state = NPS_NAN1 if allow_float else NPS_ERROR
                elif state == NPS_NAN2:
                    state = NPS_NAN3
                elif state == NPS_INF1:
                    state = NPS_INF2
                else:
                    state = NPS_ERROR
            # Allow spaces around text values.
            else:
                if c.isspace() if (bytes_unicode is unicode) else c in b'\x09\x0a\x0b\x0c\x0d\x20':
                    if state in (NPS_SPACE_PRE, NPS_SPACE_TAIL):
                        pass
                    elif state in (NPS_DIGITS, NPS_POINT, NPS_FRACTION, NPS_DIGITS_EXP, NPS_INF3, NPS_NAN3):
                        state = NPS_SPACE_TAIL
                    else:
                        state = NPS_ERROR
                else:
                    state = NPS_ERROR

            if state == NPS_ERROR:
                break

    if state not in (NPS_DIGITS, NPS_FRACTION, NPS_POINT, NPS_DIGITS_EXP, NPS_INF3, NPS_NAN3, NPS_SPACE_TAIL):
        raise ValueError


cdef _checkInt(s):
    return _checkNumber(<unicode>s, allow_float=False)


cdef _checkFloat(s):
    return _checkNumber(<unicode>s, allow_float=True)


cdef object _strValueOf(obj):
    if python._isString(obj):
        return obj
    if isinstance(obj, _Element):
        return textOf((<_Element>obj)._c_node) or ''
    if obj is None:
        return ''
    return unicode(obj)


cdef object _numericValueOf(obj):
    if isinstance(obj, NumberElement):
        return _parseNumber(<NumberElement>obj)
    try:
        # not always numeric, but Python will raise the right exception
        return obj.pyval
    except AttributeError:
        pass
    return obj


cdef _richcmpPyvals(left, right, int op):
    left  = getattr(left,  'pyval', left)
    right = getattr(right, 'pyval', right)
    return python.PyObject_RichCompare(left, right, op)


################################################################################
# Python type registry

cdef class PyType:
    """PyType(self, name, type_check, type_class, stringify=None)
    User defined type.

    Named type that contains a type check function, a type class that
    inherits from ObjectifiedDataElement and an optional "stringification"
    function.  The type check must take a string as argument and raise
    ValueError or TypeError if it cannot handle the string value.  It may be
    None in which case it is not considered for type guessing.  For registered
    named types, the 'stringify' function (or unicode() if None) is used to
    convert a Python object with type name 'name' to the string representation
    stored in the XML tree.

    Example::

        PyType('int', int, MyIntClass).register()

    Note that the order in which types are registered matters.  The first
    matching type will be used.
    """
    cdef readonly object name
    cdef readonly object type_check
    cdef readonly object stringify
    cdef object _type
    cdef list _schema_types
    def __init__(self, name, type_check, type_class, stringify=None):
        if isinstance(name, bytes):
            name = (<bytes>name).decode('ascii')
        elif not isinstance(name, unicode):
            raise TypeError, "Type name must be a string"
        if type_check is not None and not callable(type_check):
            raise TypeError, "Type check function must be callable (or None)"
        if name != TREE_PYTYPE_NAME and \
               not issubclass(type_class, ObjectifiedDataElement):
            raise TypeError, \
                "Data classes must inherit from ObjectifiedDataElement"
        self.name  = name
        self._type = type_class
        self.type_check = type_check
        if stringify is None:
            stringify = unicode
        self.stringify = stringify
        self._schema_types = []

    def __repr__(self):
        return "PyType(%s, %s)" % (self.name, self._type.__name__)

    def register(self, before=None, after=None):
        """register(self, before=None, after=None)

        Register the type.

        The additional keyword arguments 'before' and 'after' accept a
        sequence of type names that must appear before/after the new type in
        the type list.  If any of them is not currently known, it is simply
        ignored.  Raises ValueError if the dependencies cannot be fulfilled.
        """
        if self.name == TREE_PYTYPE_NAME:
            raise ValueError, "Cannot register tree type"
        if self.type_check is not None:
            for item in _TYPE_CHECKS:
                if item[0] is self.type_check:
                    _TYPE_CHECKS.remove(item)
                    break
            entry = (self.type_check, self)
            first_pos = 0
            last_pos = -1
            if before or after:
                if before is None:
                    before = ()
                elif after is None:
                    after = ()
                for i, (check, pytype) in enumerate(_TYPE_CHECKS):
                    if last_pos == -1 and pytype.name in before:
                        last_pos = i
                    if pytype.name in after:
                        first_pos = i+1
            if last_pos == -1:
                _TYPE_CHECKS.append(entry)
            elif first_pos > last_pos:
                raise ValueError, "inconsistent before/after dependencies"
            else:
                _TYPE_CHECKS.insert(last_pos, entry)

        _PYTYPE_DICT[self.name] = self
        for xs_type in self._schema_types:
            _SCHEMA_TYPE_DICT[xs_type] = self

    def unregister(self):
        "unregister(self)"
        if _PYTYPE_DICT.get(self.name) is self:
            del _PYTYPE_DICT[self.name]
        for xs_type, pytype in list(_SCHEMA_TYPE_DICT.items()):
            if pytype is self:
                del _SCHEMA_TYPE_DICT[xs_type]
        if self.type_check is None:
            return
        try:
            _TYPE_CHECKS.remove( (self.type_check, self) )
        except ValueError:
            pass

    property xmlSchemaTypes:
        """The list of XML Schema datatypes this Python type maps to.

        Note that this must be set before registering the type!
        """
        def __get__(self):
            return self._schema_types
        def __set__(self, types):
            self._schema_types = list(map(unicode, types))


cdef dict _PYTYPE_DICT = {}
cdef dict _SCHEMA_TYPE_DICT = {}
cdef list _TYPE_CHECKS = []

cdef unicode _xml_bool(value):
    return "true" if value else "false"

cdef unicode _xml_float(value):
    if _float_is_inf(value):
        if value > 0:
            return "INF"
        return "-INF"
    if _float_is_nan(value):
        return "NaN"
    return unicode(repr(value))

cdef _pytypename(obj):
    return "str" if python._isString(obj) else _typename(obj)

def pytypename(obj):
    """pytypename(obj)

    Find the name of the corresponding PyType for a Python object.
    """
    return _pytypename(obj)

cdef _registerPyTypes():
    pytype = PyType('int', _checkInt, IntElement)  # wraps functions for Python
    pytype.xmlSchemaTypes = ("integer", "int", "short", "byte", "unsignedShort",
                             "unsignedByte", "nonPositiveInteger",
                             "negativeInteger", "long", "nonNegativeInteger",
                             "unsignedLong", "unsignedInt", "positiveInteger",)
    pytype.register()

    # 'long' type just for backwards compatibility
    pytype = PyType('long', None, IntElement)
    pytype.register()

    pytype = PyType('float', _checkFloat, FloatElement, _xml_float)  # wraps functions for Python
    pytype.xmlSchemaTypes = ("double", "float")
    pytype.register()

    pytype = PyType('bool', _checkBool, BoolElement, _xml_bool)  # wraps functions for Python
    pytype.xmlSchemaTypes = ("boolean",)
    pytype.register()

    pytype = PyType('str', None, StringElement)
    pytype.xmlSchemaTypes = ("string", "normalizedString", "token", "language",
                             "Name", "NCName", "ID", "IDREF", "ENTITY",
                             "NMTOKEN", )
    pytype.register()

    # since lxml 2.0
    pytype = PyType('NoneType', None, NoneElement)
    pytype.register()

    # backwards compatibility
    pytype = PyType('none', None, NoneElement)
    pytype.register()

# non-registered PyType for inner tree elements
cdef PyType TREE_PYTYPE = PyType(TREE_PYTYPE_NAME, None, ObjectifiedElement)

_registerPyTypes()

def getRegisteredTypes():
    """getRegisteredTypes()

    Returns a list of the currently registered PyType objects.

    To add a new type, retrieve this list and call unregister() for all
    entries.  Then add the new type at a suitable position (possibly replacing
    an existing one) and call register() for all entries.

    This is necessary if the new type interferes with the type check functions
    of existing ones (normally only int/float/bool) and must the tried before
    other types.  To add a type that is not yet parsable by the current type
    check functions, you can simply register() it, which will append it to the
    end of the type list.
    """
    cdef list types = []
    cdef set known = set()
    for check, pytype in _TYPE_CHECKS:
        name = pytype.name
        if name not in known:
            known.add(name)
            types.append(pytype)
    for pytype in _PYTYPE_DICT.values():
        name = pytype.name
        if name not in known:
            known.add(name)
            types.append(pytype)
    return types

cdef PyType _guessPyType(value, PyType defaulttype):
    if value is None:
        return None
    for type_check, tested_pytype in _TYPE_CHECKS:
        try:
            type_check(value)
            return <PyType>tested_pytype
        except IGNORABLE_ERRORS:
            # could not be parsed as the specified type => ignore
            pass
    return defaulttype

cdef object _guessElementClass(tree.xmlNode* c_node):
    value = textOf(c_node)
    if value is None:
        return None
    if value == '':
        return StringElement

    for type_check, pytype in _TYPE_CHECKS:
        try:
            type_check(value)
            return (<PyType>pytype)._type
        except IGNORABLE_ERRORS:
            pass
    return None

################################################################################
# adapted ElementMaker supports registered PyTypes

@cython.final
@cython.internal
cdef class _ObjectifyElementMakerCaller:
    cdef object _tag
    cdef object _nsmap
    cdef object _element_factory
    cdef bint _annotate

    def __call__(self, *children, **attrib):
        "__call__(self, *children, **attrib)"
        cdef _ObjectifyElementMakerCaller elementMaker
        cdef _Element element
        cdef _Element childElement
        cdef bint has_children
        cdef bint has_string_value
        if self._element_factory is None:
            element = _makeElement(self._tag, None, attrib, self._nsmap)
        else:
            element = self._element_factory(self._tag, attrib, self._nsmap)

        pytype_name = None
        has_children = False
        has_string_value = False
        for child in children:
            if child is None:
                if len(children) == 1:
                    cetree.setAttributeValue(
                        element, XML_SCHEMA_INSTANCE_NIL_ATTR, "true")
            elif python._isString(child):
                _add_text(element, child)
                has_string_value = True
            elif isinstance(child, _Element):
                cetree.appendChildToElement(element, <_Element>child)
                has_children = True
            elif isinstance(child, _ObjectifyElementMakerCaller):
                elementMaker = <_ObjectifyElementMakerCaller>child
                if elementMaker._element_factory is None:
                    cetree.makeSubElement(element, elementMaker._tag,
                                          None, None, None, None)
                else:
                    childElement = elementMaker._element_factory(
                        elementMaker._tag)
                    cetree.appendChildToElement(element, childElement)
                has_children = True
            elif isinstance(child, dict):
                for name, value in child.items():
                    # keyword arguments in attrib take precedence
                    if name in attrib:
                        continue
                    pytype = _PYTYPE_DICT.get(_typename(value))
                    if pytype is not None:
                        value = (<PyType>pytype).stringify(value)
                    elif not python._isString(value):
                        value = unicode(value)
                    cetree.setAttributeValue(element, name, value)
            else:
                if pytype_name is not None:
                    # concatenation always makes the result a string
                    has_string_value = True
                pytype_name = _typename(child)
                pytype = _PYTYPE_DICT.get(_typename(child))
                if pytype is not None:
                    _add_text(element, (<PyType>pytype).stringify(child))
                else:
                    has_string_value = True
                    child = unicode(child)
                    _add_text(element, child)

        if self._annotate and not has_children:
            if has_string_value:
                cetree.setAttributeValue(element, PYTYPE_ATTRIBUTE, "str")
            elif pytype_name is not None:
                cetree.setAttributeValue(element, PYTYPE_ATTRIBUTE, pytype_name)

        return element

cdef _add_text(_Element elem, text):
    # add text to the tree in construction, either as element text or
    # tail text, depending on the current tree state
    cdef tree.xmlNode* c_child
    c_child = cetree.findChildBackwards(elem._c_node, 0)
    if c_child is not NULL:
        old = cetree.tailOf(c_child)
        if old is not None:
            text = old + text
        cetree.setTailText(c_child, text)
    else:
        old = cetree.textOf(elem._c_node)
        if old is not None:
            text = old + text
        cetree.setNodeText(elem._c_node, text)

cdef class ElementMaker:
    """ElementMaker(self, namespace=None, nsmap=None, annotate=True, makeelement=None)

    An ElementMaker that can be used for constructing trees.

    Example::

      >>> M = ElementMaker(annotate=False)
      >>> attributes = {'class': 'par'}
      >>> html = M.html( M.body( M.p('hello', attributes, M.br, 'objectify', style="font-weight: bold") ) )

      >>> from lxml.etree import tostring
      >>> print(tostring(html, method='html').decode('ascii'))
      <html><body><p style="font-weight: bold" class="par">hello<br>objectify</p></body></html>

    To create tags that are not valid Python identifiers, call the factory
    directly and pass the tag name as first argument::

      >>> root = M('tricky-tag', 'some text')
      >>> print(root.tag)
      tricky-tag
      >>> print(root.text)
      some text

    Note that this module has a predefined ElementMaker instance called ``E``.
    """
    cdef object _makeelement
    cdef object _namespace
    cdef object _nsmap
    cdef bint _annotate
    cdef dict _cache
    def __init__(self, *, namespace=None, nsmap=None, annotate=True,
                 makeelement=None):
        if nsmap is None:
            nsmap = _DEFAULT_NSMAP if annotate else {}
        self._nsmap = nsmap
        self._namespace = None if namespace is None else "{%s}" % namespace
        self._annotate = annotate
        if makeelement is not None:
            if not callable(makeelement):
                raise TypeError(
                    f"argument of 'makeelement' parameter must be callable, got {type(makeelement)}")
            self._makeelement = makeelement
        else:
            self._makeelement = None
        self._cache = {}

    @cython.final
    cdef _build_element_maker(self, tag, bint caching):
        cdef _ObjectifyElementMakerCaller element_maker
        element_maker = _ObjectifyElementMakerCaller.__new__(_ObjectifyElementMakerCaller)
        if self._namespace is not None and tag[0] != "{":
            element_maker._tag = self._namespace + tag
        else:
            element_maker._tag = tag
        element_maker._nsmap = self._nsmap
        element_maker._annotate = self._annotate
        element_maker._element_factory = self._makeelement
        if caching:
            if len(self._cache) > 200:
                self._cache.clear()
            self._cache[tag] = element_maker
        return element_maker

    def __getattr__(self, tag):
        element_maker = self._cache.get(tag)
        if element_maker is None:
            return self._build_element_maker(tag, caching=True)
        return element_maker

    def __call__(self, tag, *args, **kwargs):
        element_maker = self._cache.get(tag)
        if element_maker is None:
            element_maker = self._build_element_maker(
                tag, caching=not is_special_method(tag))
        return element_maker(*args, **kwargs)

################################################################################
# Recursive element dumping

cdef bint __RECURSIVE_STR = 0 # default: off

def enable_recursive_str(on=True):
    """enable_recursive_str(on=True)

    Enable a recursively generated tree representation for str(element),
    based on objectify.dump(element).
    """
    global __RECURSIVE_STR
    __RECURSIVE_STR = on

def dump(_Element element not None):
    """dump(_Element element not None)

    Return a recursively generated string representation of an element.
    """
    return _dump(element, 0)

cdef object _dump(_Element element, int indent):
    indentstr = "    " * indent
    if isinstance(element, ObjectifiedDataElement):
        value = repr(element)
    else:
        value = textOf(element._c_node)
        if value is not None:
            if not value.strip():
                value = None
            else:
                value = repr(value)
    result = f"{indentstr}{element.tag} = {value} [{_typename(element)}]\n"
    xsi_ns    = "{%s}" % XML_SCHEMA_INSTANCE_NS
    pytype_ns = "{%s}" % PYTYPE_NAMESPACE
    for name, value in sorted(cetree.iterattributes(element, 3)):
        if '{' in name:
            if name == PYTYPE_ATTRIBUTE:
                if value == TREE_PYTYPE_NAME:
                    continue
                else:
                    name = name.replace(pytype_ns, 'py:')
            name = name.replace(xsi_ns, 'xsi:')
        result += f"{indentstr}  * {name} = {value!r}\n"

    indent += 1
    for child in element.iterchildren():
        result += _dump(child, indent)
    if indent == 1:
        return result[:-1] # strip last '\n'
    else:
        return result


################################################################################
# Pickle support for objectified ElementTree

def __unpickleElementTree(data):
    return etree.ElementTree(fromstring(data))

cdef _setupPickle(elementTreeReduceFunction):
    import copyreg
    copyreg.pickle(etree._ElementTree,
                   elementTreeReduceFunction, __unpickleElementTree)

def pickleReduceElementTree(obj):
    return __unpickleElementTree, (etree.tostring(obj),)

_setupPickle(pickleReduceElementTree)
del pickleReduceElementTree

################################################################################
# Element class lookup

cdef class ObjectifyElementClassLookup(ElementClassLookup):
    """ObjectifyElementClassLookup(self, tree_class=None, empty_data_class=None)
    Element class lookup method that uses the objectify classes.
    """
    cdef object empty_data_class
    cdef object tree_class
    def __init__(self, tree_class=None, empty_data_class=None):
        """Lookup mechanism for objectify.

        The default Element classes can be replaced by passing subclasses of
        ObjectifiedElement and ObjectifiedDataElement as keyword arguments.
        'tree_class' defines inner tree classes (defaults to
        ObjectifiedElement), 'empty_data_class' defines the default class for
        empty data elements (defaults to StringElement).
        """
        self._lookup_function = _lookupElementClass
        if tree_class is None:
            tree_class = ObjectifiedElement
        self.tree_class = tree_class
        if empty_data_class is None:
            empty_data_class = StringElement
        self.empty_data_class = empty_data_class

cdef object _lookupElementClass(state, _Document doc, tree.xmlNode* c_node):
    cdef ObjectifyElementClassLookup lookup
    lookup = <ObjectifyElementClassLookup>state
    # if element has children => no data class
    if cetree.hasChild(c_node):
        return lookup.tree_class

    # if element is defined as xsi:nil, return NoneElement class
    if "true" == cetree.attributeValueFromNsName(
        c_node, _XML_SCHEMA_INSTANCE_NS, <unsigned char*>"nil"):
        return NoneElement

    # check for Python type hint
    value = cetree.attributeValueFromNsName(
        c_node, _PYTYPE_NAMESPACE, _PYTYPE_ATTRIBUTE_NAME)
    if value is not None:
        if value == TREE_PYTYPE_NAME:
            return lookup.tree_class
        py_type = <PyType>_PYTYPE_DICT.get(value)
        if py_type is not None:
            return py_type._type
        # unknown 'pyval' => try to figure it out ourself, just go on

    # check for XML Schema type hint
    value = cetree.attributeValueFromNsName(
        c_node, _XML_SCHEMA_INSTANCE_NS, <unsigned char*>"type")

    if value is not None:
        schema_type = <PyType>_SCHEMA_TYPE_DICT.get(value)
        if schema_type is None and ':' in value:
            prefix, value = value.split(':', 1)
            schema_type = <PyType>_SCHEMA_TYPE_DICT.get(value)
        if schema_type is not None:
            return schema_type._type

    # otherwise determine class based on text content type
    el_class = _guessElementClass(c_node)
    if el_class is not None:
        return el_class

    # if element is a root node => default to tree node
    if c_node.parent is NULL or not tree._isElement(c_node.parent):
        return lookup.tree_class

    return lookup.empty_data_class


################################################################################
# Type annotations

cdef PyType _check_type(tree.xmlNode* c_node, PyType pytype):
    if pytype is None:
        return None
    value = textOf(c_node)
    try:
        pytype.type_check(value)
        return pytype
    except IGNORABLE_ERRORS:
        # could not be parsed as the specified type => ignore
        pass
    return None

def pyannotate(element_or_tree, *, ignore_old=False, ignore_xsi=False,
             empty_pytype=None):
    """pyannotate(element_or_tree, ignore_old=False, ignore_xsi=False, empty_pytype=None)

    Recursively annotates the elements of an XML tree with 'pytype'
    attributes.

    If the 'ignore_old' keyword argument is True (the default), current 'pytype'
    attributes will be ignored and replaced.  Otherwise, they will be checked
    and only replaced if they no longer fit the current text value.

    Setting the keyword argument ``ignore_xsi`` to True makes the function
    additionally ignore existing ``xsi:type`` annotations.  The default is to
    use them as a type hint.

    The default annotation of empty elements can be set with the
    ``empty_pytype`` keyword argument.  The default is not to annotate empty
    elements.  Pass 'str', for example, to make string values the default.
    """
    cdef _Element  element
    element = cetree.rootNodeOrRaise(element_or_tree)
    _annotate(element, 0, 1, ignore_xsi, ignore_old, None, empty_pytype)

def xsiannotate(element_or_tree, *, ignore_old=False, ignore_pytype=False,
                empty_type=None):
    """xsiannotate(element_or_tree, ignore_old=False, ignore_pytype=False, empty_type=None)

    Recursively annotates the elements of an XML tree with 'xsi:type'
    attributes.

    If the 'ignore_old' keyword argument is True (the default), current
    'xsi:type' attributes will be ignored and replaced.  Otherwise, they will be
    checked and only replaced if they no longer fit the current text value.

    Note that the mapping from Python types to XSI types is usually ambiguous.
    Currently, only the first XSI type name in the corresponding PyType
    definition will be used for annotation.  Thus, you should consider naming
    the widest type first if you define additional types.

    Setting the keyword argument ``ignore_pytype`` to True makes the function
    additionally ignore existing ``pytype`` annotations.  The default is to
    use them as a type hint.

    The default annotation of empty elements can be set with the
    ``empty_type`` keyword argument.  The default is not to annotate empty
    elements.  Pass 'string', for example, to make string values the default.
    """
    cdef _Element  element
    element = cetree.rootNodeOrRaise(element_or_tree)
    _annotate(element, 1, 0, ignore_old, ignore_pytype, empty_type, None)

def annotate(element_or_tree, *, ignore_old=True, ignore_xsi=False,
             empty_pytype=None, empty_type=None, annotate_xsi=0,
             annotate_pytype=1):
    """annotate(element_or_tree, ignore_old=True, ignore_xsi=False, empty_pytype=None, empty_type=None, annotate_xsi=0, annotate_pytype=1)

    Recursively annotates the elements of an XML tree with 'xsi:type'
    and/or 'py:pytype' attributes.

    If the 'ignore_old' keyword argument is True (the default), current
    'py:pytype' attributes will be ignored for the type annotation. Set to False
    if you want reuse existing 'py:pytype' information (iff appropriate for the
    element text value).

    If the 'ignore_xsi' keyword argument is False (the default), existing
    'xsi:type' attributes will be used for the type annotation, if they fit the
    element text values.

    Note that the mapping from Python types to XSI types is usually ambiguous.
    Currently, only the first XSI type name in the corresponding PyType
    definition will be used for annotation.  Thus, you should consider naming
    the widest type first if you define additional types.

    The default 'py:pytype' annotation of empty elements can be set with the
    ``empty_pytype`` keyword argument. Pass 'str', for example, to make
    string values the default.

    The default 'xsi:type' annotation of empty elements can be set with the
    ``empty_type`` keyword argument.  The default is not to annotate empty
    elements.  Pass 'string', for example, to make string values the default.

    The keyword arguments 'annotate_xsi' (default: 0) and 'annotate_pytype'
    (default: 1) control which kind(s) of annotation to use.
    """
    cdef _Element  element
    element = cetree.rootNodeOrRaise(element_or_tree)
    _annotate(element, annotate_xsi, annotate_pytype, ignore_xsi,
              ignore_old, empty_type, empty_pytype)


cdef _annotate(_Element element, bint annotate_xsi, bint annotate_pytype,
               bint ignore_xsi, bint ignore_pytype,
               empty_type_name, empty_pytype_name):
    cdef _Document doc
    cdef tree.xmlNode* c_node
    cdef PyType empty_pytype, StrType, NoneType

    if not annotate_xsi and not annotate_pytype:
        return

    if empty_type_name is not None:
        if isinstance(empty_type_name, bytes):
            empty_type_name = (<bytes>empty_type_name).decode("ascii")
        empty_pytype = <PyType>_SCHEMA_TYPE_DICT.get(empty_type_name)
    elif empty_pytype_name is not None:
        if isinstance(empty_pytype_name, bytes):
            empty_pytype_name = (<bytes>empty_pytype_name).decode("ascii")
        empty_pytype = <PyType>_PYTYPE_DICT.get(empty_pytype_name)
    else:
        empty_pytype = None

    StrType  = <PyType>_PYTYPE_DICT.get('str')
    NoneType = <PyType>_PYTYPE_DICT.get('NoneType')

    doc = element._doc
    c_node = element._c_node
    tree.BEGIN_FOR_EACH_ELEMENT_FROM(c_node, c_node, 1)
    if c_node.type == tree.XML_ELEMENT_NODE:
        _annotate_element(c_node, doc, annotate_xsi, annotate_pytype,
                          ignore_xsi, ignore_pytype,
                          empty_type_name, empty_pytype, StrType, NoneType)
    tree.END_FOR_EACH_ELEMENT_FROM(c_node)

cdef int _annotate_element(tree.xmlNode* c_node, _Document doc,
                           bint annotate_xsi, bint annotate_pytype,
                           bint ignore_xsi, bint ignore_pytype,
                           empty_type_name, PyType empty_pytype,
                           PyType StrType, PyType NoneType) except -1:
    cdef tree.xmlNs*   c_ns
    cdef PyType pytype = None
    typename = None
    istree = 0

    # if element is defined as xsi:nil, represent it as None
    if cetree.attributeValueFromNsName(
        c_node, _XML_SCHEMA_INSTANCE_NS, <unsigned char*>"nil") == "true":
        pytype = NoneType

    if pytype is None and not ignore_xsi:
        # check that old xsi type value is valid
        typename = cetree.attributeValueFromNsName(
            c_node, _XML_SCHEMA_INSTANCE_NS, <unsigned char*>"type")
        if typename is not None:
            pytype = <PyType>_SCHEMA_TYPE_DICT.get(typename)
            if pytype is None and ':' in typename:
                prefix, typename = typename.split(':', 1)
                pytype = <PyType>_SCHEMA_TYPE_DICT.get(typename)
            if pytype is not None and pytype is not StrType:
                # StrType does not have a typecheck but is the default
                # anyway, so just accept it if given as type
                # information
                pytype = _check_type(c_node, pytype)
                if pytype is None:
                    typename = None

    if pytype is None and not ignore_pytype:
        # check that old pytype value is valid
        old_pytypename = cetree.attributeValueFromNsName(
            c_node, _PYTYPE_NAMESPACE, _PYTYPE_ATTRIBUTE_NAME)
        if old_pytypename is not None:
            if old_pytypename == TREE_PYTYPE_NAME:
                if not cetree.hasChild(c_node):
                    # only case where we should keep it,
                    # everything else is clear enough
                    pytype = TREE_PYTYPE
            else:
                if old_pytypename == 'none':
                    # transition from lxml 1.x
                    old_pytypename = "NoneType"
                pytype = <PyType>_PYTYPE_DICT.get(old_pytypename)
                if pytype is not None and pytype is not StrType:
                    # StrType does not have a typecheck but is the
                    # default anyway, so just accept it if given as
                    # type information
                    pytype = _check_type(c_node, pytype)

    if pytype is None:
        # try to guess type
        if not cetree.hasChild(c_node):
            # element has no children => data class
            pytype = _guessPyType(textOf(c_node), StrType)
        else:
            istree = 1

    if pytype is None:
        # use default type for empty elements
        if cetree.hasText(c_node):
            pytype = StrType
        else:
            pytype = empty_pytype
            if typename is None:
                typename = empty_type_name

    if pytype is not None:
        if typename is None:
            if not istree:
                if pytype._schema_types:
                    # pytype->xsi:type is a 1:n mapping
                    # simply take the first
                    typename = pytype._schema_types[0]
        elif typename not in pytype._schema_types:
            typename = pytype._schema_types[0]

    if annotate_xsi:
        if typename is None or istree:
            cetree.delAttributeFromNsName(
                c_node, _XML_SCHEMA_INSTANCE_NS, <unsigned char*>"type")
        else:
            # update or create attribute
            typename_utf8 = cetree.utf8(typename)
            c_ns = cetree.findOrBuildNodeNsPrefix(
                doc, c_node, _XML_SCHEMA_NS, <unsigned char*>'xsd')
            if c_ns is not NULL:
                if b':' in typename_utf8:
                    prefix, name = typename_utf8.split(b':', 1)
                    if c_ns.prefix is NULL or c_ns.prefix[0] == c'\0':
                        typename_utf8 = name
                    elif tree.xmlStrcmp(_xcstr(prefix), c_ns.prefix) != 0:
                        typename_utf8 = (<unsigned char*>c_ns.prefix) + b':' + name
                elif c_ns.prefix is not NULL and c_ns.prefix[0] != c'\0':
                    typename_utf8 = (<unsigned char*>c_ns.prefix) + b':' + typename_utf8
            c_ns = cetree.findOrBuildNodeNsPrefix(
                doc, c_node, _XML_SCHEMA_INSTANCE_NS, <unsigned char*>'xsi')
            tree.xmlSetNsProp(c_node, c_ns, <unsigned char*>"type", _xcstr(typename_utf8))

    if annotate_pytype:
        if pytype is None:
            # delete attribute if it exists
            cetree.delAttributeFromNsName(
                c_node, _PYTYPE_NAMESPACE, _PYTYPE_ATTRIBUTE_NAME)
        else:
            # update or create attribute
            c_ns = cetree.findOrBuildNodeNsPrefix(
                doc, c_node, _PYTYPE_NAMESPACE, <unsigned char*>'py')
            pytype_name = cetree.utf8(pytype.name)
            tree.xmlSetNsProp(c_node, c_ns, _PYTYPE_ATTRIBUTE_NAME,
                              _xcstr(pytype_name))
            if pytype is NoneType:
                c_ns = cetree.findOrBuildNodeNsPrefix(
                    doc, c_node, _XML_SCHEMA_INSTANCE_NS, <unsigned char*>'xsi')
                tree.xmlSetNsProp(c_node, c_ns, <unsigned char*>"nil", <unsigned char*>"true")

    return 0

cdef object _strip_attributes = etree.strip_attributes
cdef object _cleanup_namespaces = etree.cleanup_namespaces

def deannotate(element_or_tree, *, bint pytype=True, bint xsi=True,
               bint xsi_nil=False, bint cleanup_namespaces=False):
    """deannotate(element_or_tree, pytype=True, xsi=True, xsi_nil=False, cleanup_namespaces=False)

    Recursively de-annotate the elements of an XML tree by removing 'py:pytype'
    and/or 'xsi:type' attributes and/or 'xsi:nil' attributes.

    If the 'pytype' keyword argument is True (the default), 'py:pytype'
    attributes will be removed. If the 'xsi' keyword argument is True (the
    default), 'xsi:type' attributes will be removed.
    If the 'xsi_nil' keyword argument is True (default: False), 'xsi:nil'
    attributes will be removed.

    Note that this does not touch the namespace declarations by
    default.  If you want to remove unused namespace declarations from
    the tree, pass the option ``cleanup_namespaces=True``.
    """
    cdef list attribute_names = []

    if pytype:
        attribute_names.append(PYTYPE_ATTRIBUTE)
    if xsi:
        attribute_names.append(XML_SCHEMA_INSTANCE_TYPE_ATTR)
    if xsi_nil:
        attribute_names.append(XML_SCHEMA_INSTANCE_NIL_ATTR)

    _strip_attributes(element_or_tree, *attribute_names)
    if cleanup_namespaces:
        _cleanup_namespaces(element_or_tree)

################################################################################
# Module level parser setup

cdef object __DEFAULT_PARSER
__DEFAULT_PARSER = etree.XMLParser(remove_blank_text=True)
__DEFAULT_PARSER.set_element_class_lookup( ObjectifyElementClassLookup() )

cdef object objectify_parser
objectify_parser = __DEFAULT_PARSER

def set_default_parser(new_parser = None):
    """set_default_parser(new_parser = None)

    Replace the default parser used by objectify's Element() and
    fromstring() functions.

    The new parser must be an etree.XMLParser.

    Call without arguments to reset to the original parser.
    """
    global objectify_parser
    if new_parser is None:
        objectify_parser = __DEFAULT_PARSER
    elif isinstance(new_parser, etree.XMLParser):
        objectify_parser = new_parser
    else:
        raise TypeError, "parser must inherit from lxml.etree.XMLParser"

def makeparser(**kw):
    """makeparser(remove_blank_text=True, **kw)

    Create a new XML parser for objectify trees.

    You can pass all keyword arguments that are supported by
    ``etree.XMLParser()``.  Note that this parser defaults to removing
    blank text.  You can disable this by passing the
    ``remove_blank_text`` boolean keyword option yourself.
    """
    if 'remove_blank_text' not in kw:
        kw['remove_blank_text'] = True
    parser = etree.XMLParser(**kw)
    parser.set_element_class_lookup( ObjectifyElementClassLookup() )
    return parser

cdef _Element _makeElement(tag, text, attrib, nsmap):
    return cetree.makeElement(tag, None, objectify_parser, text, None, attrib, nsmap)

################################################################################
# Module level factory functions

cdef object _fromstring
_fromstring = etree.fromstring

SubElement = etree.SubElement

def fromstring(xml, parser=None, *, base_url=None):
    """fromstring(xml, parser=None, base_url=None)

    Objectify specific version of the lxml.etree fromstring() function
    that uses the objectify parser.

    You can pass a different parser as second argument.

    The ``base_url`` keyword argument allows to set the original base URL of
    the document to support relative Paths when looking up external entities
    (DTD, XInclude, ...).
    """
    if parser is None:
        parser = objectify_parser
    return _fromstring(xml, parser, base_url=base_url)

def XML(xml, parser=None, *, base_url=None):
    """XML(xml, parser=None, base_url=None)

    Objectify specific version of the lxml.etree XML() literal factory
    that uses the objectify parser.

    You can pass a different parser as second argument.

    The ``base_url`` keyword argument allows to set the original base URL of
    the document to support relative Paths when looking up external entities
    (DTD, XInclude, ...).
    """
    if parser is None:
        parser = objectify_parser
    return _fromstring(xml, parser, base_url=base_url)

cdef object _parse
_parse = etree.parse

def parse(f, parser=None, *, base_url=None):
    """parse(f, parser=None, base_url=None)

    Parse a file or file-like object with the objectify parser.

    You can pass a different parser as second argument.

    The ``base_url`` keyword allows setting a URL for the document
    when parsing from a file-like object.  This is needed when looking
    up external entities (DTD, XInclude, ...) with relative paths.
    """
    if parser is None:
        parser = objectify_parser
    return _parse(f, parser, base_url=base_url)

cdef dict _DEFAULT_NSMAP = {
    "py"  : PYTYPE_NAMESPACE,
    "xsi" : XML_SCHEMA_INSTANCE_NS,
    "xsd" : XML_SCHEMA_NS
}

E = ElementMaker()

def Element(_tag, attrib=None, nsmap=None, *, _pytype=None, **_attributes):
    """Element(_tag, attrib=None, nsmap=None, _pytype=None, **_attributes)

    Objectify specific version of the lxml.etree Element() factory that
    always creates a structural (tree) element.

    NOTE: requires parser based element class lookup activated in lxml.etree!
    """
    if attrib is not None:
        if _attributes:
            attrib = dict(attrib)
            attrib.update(_attributes)
        _attributes = attrib
    if _pytype is None:
        _pytype = TREE_PYTYPE_NAME
    if nsmap is None:
        nsmap = _DEFAULT_NSMAP
    _attributes[PYTYPE_ATTRIBUTE] = _pytype
    return _makeElement(_tag, None, _attributes, nsmap)

def DataElement(_value, attrib=None, nsmap=None, *, _pytype=None, _xsi=None,
                **_attributes):
    """DataElement(_value, attrib=None, nsmap=None, _pytype=None, _xsi=None, **_attributes)

    Create a new element from a Python value and XML attributes taken from
    keyword arguments or a dictionary passed as second argument.

    Automatically adds a 'pytype' attribute for the Python type of the value,
    if the type can be identified.  If '_pytype' or '_xsi' are among the
    keyword arguments, they will be used instead.

    If the _value argument is an ObjectifiedDataElement instance, its py:pytype,
    xsi:type and other attributes and nsmap are reused unless they are redefined
    in attrib and/or keyword arguments.
    """
    if nsmap is None:
        nsmap = _DEFAULT_NSMAP
    if attrib is not None and attrib:
        if _attributes:
            attrib = dict(attrib)
            attrib.update(_attributes)
        _attributes = attrib
    if isinstance(_value, ObjectifiedElement):
        if _pytype is None:
            if _xsi is None and not _attributes and nsmap is _DEFAULT_NSMAP:
                # special case: no change!
                return _value.__copy__()
    if isinstance(_value, ObjectifiedDataElement):
        # reuse existing nsmap unless redefined in nsmap parameter
        temp = _value.nsmap
        if temp is not None and temp:
            temp = dict(temp)
            temp.update(nsmap)
            nsmap = temp
        # reuse existing attributes unless redefined in attrib/_attributes
        temp = _value.attrib
        if temp is not None and temp:
            temp = dict(temp)
            temp.update(_attributes)
            _attributes = temp
        # reuse existing xsi:type or py:pytype attributes, unless provided as
        # arguments
        if _xsi is None and _pytype is None:
            _xsi = _attributes.get(XML_SCHEMA_INSTANCE_TYPE_ATTR)
            _pytype = _attributes.get(PYTYPE_ATTRIBUTE)

    if _xsi is not None:
        if ':' in _xsi:
            prefix, name = _xsi.split(':', 1)
            ns = nsmap.get(prefix)
            if ns != XML_SCHEMA_NS:
                raise ValueError, "XSD types require the XSD namespace"
        elif nsmap is _DEFAULT_NSMAP:
            name = _xsi
            _xsi = 'xsd:' + _xsi
        else:
            name = _xsi
            for prefix, ns in nsmap.items():
                if ns == XML_SCHEMA_NS:
                    if prefix is not None and prefix:
                        _xsi = prefix + ':' + _xsi
                    break
            else:
                raise ValueError, "XSD types require the XSD namespace"
        _attributes[XML_SCHEMA_INSTANCE_TYPE_ATTR] = _xsi
        if _pytype is None:
            # allow using unregistered or even wrong xsi:type names
            py_type = <PyType>_SCHEMA_TYPE_DICT.get(_xsi)
            if py_type is None:
                py_type = <PyType>_SCHEMA_TYPE_DICT.get(name)
            if py_type is not None:
                _pytype = py_type.name

    if _pytype is None:
        _pytype = _pytypename(_value)

    if _value is None and _pytype != "str":
        _pytype = _pytype or "NoneType"
        strval = None
    elif python._isString(_value):
        strval = _value
    elif isinstance(_value, bool):
        if _value:
            strval = "true"
        else:
            strval = "false"
    else:
        py_type = <PyType>_PYTYPE_DICT.get(_pytype)
        stringify = unicode if py_type is None else py_type.stringify
        strval = stringify(_value)

    if _pytype is not None:
        if _pytype == "NoneType" or _pytype == "none":
            strval = None
            _attributes[XML_SCHEMA_INSTANCE_NIL_ATTR] = "true"
        else:
            # check if type information from arguments is valid
            py_type = <PyType>_PYTYPE_DICT.get(_pytype)
            if py_type is not None:
                if py_type.type_check is not None:
                    py_type.type_check(strval)
                _attributes[PYTYPE_ATTRIBUTE] = _pytype

    return _makeElement("value", strval, _attributes, nsmap)


################################################################################
# ObjectPath

include "objectpath.pxi"
