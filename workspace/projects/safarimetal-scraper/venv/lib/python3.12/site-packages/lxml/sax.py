"""
SAX-based adapter to copy trees from/to the Python standard library.

Use the `ElementTreeContentHandler` class to build an ElementTree from
SAX events.

Use the `ElementTreeProducer` class or the `saxify()` function to fire
the SAX events of an ElementTree against a SAX ContentHandler.

See https://lxml.de/sax.html
"""


from xml.sax.handler import ContentHandler
from lxml import etree
from lxml.etree import ElementTree, SubElement
from lxml.etree import Comment, ProcessingInstruction

try:
    from types import GenericAlias as _GenericAlias
except ImportError:
    # Python 3.8 - we only need this as return value from "__class_getitem__"
    def _GenericAlias(cls, item):
        return f"{cls.__name__}[{item.__name__}]"


class SaxError(etree.LxmlError):
    """General SAX error.
    """


def _getNsTag(tag):
    if tag[0] == '{' and '}' in tag:
        return tuple(tag[1:].split('}', 1))
    else:
        return None, tag


class ElementTreeContentHandler(ContentHandler):
    """Build an lxml ElementTree from SAX events.
    """
    def __init__(self, makeelement=None):
        ContentHandler.__init__(self)
        self._root = None
        self._root_siblings = []
        self._element_stack = []
        self._default_ns = None
        self._ns_mapping = { None : [None] }
        self._new_mappings = {}
        if makeelement is None:
            makeelement = etree.Element
        self._makeelement = makeelement

    def _get_etree(self):
        "Contains the generated ElementTree after parsing is finished."
        return ElementTree(self._root)

    etree = property(_get_etree, doc=_get_etree.__doc__)

    def setDocumentLocator(self, locator):
        pass

    def startDocument(self):
        pass

    def endDocument(self):
        pass

    def startPrefixMapping(self, prefix, uri):
        self._new_mappings[prefix] = uri
        try:
            self._ns_mapping[prefix].append(uri)
        except KeyError:
            self._ns_mapping[prefix] = [uri]
        if prefix is None:
            self._default_ns = uri

    def endPrefixMapping(self, prefix):
        ns_uri_list = self._ns_mapping[prefix]
        ns_uri_list.pop()
        if prefix is None:
            self._default_ns = ns_uri_list[-1]

    def _buildTag(self, ns_name_tuple):
        ns_uri, local_name = ns_name_tuple
        if ns_uri:
            el_tag = "{%s}%s" % ns_name_tuple
        elif self._default_ns:
            el_tag = "{%s}%s" % (self._default_ns, local_name)
        else:
            el_tag = local_name
        return el_tag

    def startElementNS(self, ns_name, qname, attributes=None):
        el_name = self._buildTag(ns_name)
        if attributes:
            attrs = {}
            try:
                iter_attributes = attributes.iteritems()
            except AttributeError:
                iter_attributes = attributes.items()

            for name_tuple, value in iter_attributes:
                if name_tuple[0]:
                    attr_name = "{%s}%s" % name_tuple
                else:
                    attr_name = name_tuple[1]
                attrs[attr_name] = value
        else:
            attrs = None

        element_stack = self._element_stack
        if self._root is None:
            element = self._root = \
                      self._makeelement(el_name, attrs, self._new_mappings)
            if self._root_siblings and hasattr(element, 'addprevious'):
                for sibling in self._root_siblings:
                    element.addprevious(sibling)
            del self._root_siblings[:]
        else:
            element = SubElement(element_stack[-1], el_name,
                                 attrs, self._new_mappings)
        element_stack.append(element)

        self._new_mappings.clear()

    def processingInstruction(self, target, data):
        pi = ProcessingInstruction(target, data)
        if self._root is None:
            self._root_siblings.append(pi)
        else:
            self._element_stack[-1].append(pi)

    def endElementNS(self, ns_name, qname):
        element = self._element_stack.pop()
        el_tag = self._buildTag(ns_name)
        if el_tag != element.tag:
            raise SaxError("Unexpected element closed: " + el_tag)

    def startElement(self, name, attributes=None):
        if attributes:
            attributes = {(None, k): v for k, v in attributes.items()}
        self.startElementNS((None, name), name, attributes)

    def endElement(self, name):
        self.endElementNS((None, name), name)

    def characters(self, data):
        last_element = self._element_stack[-1]
        try:
            # if there already is a child element, we must append to its tail
            last_element = last_element[-1]
        except IndexError:
            # otherwise: append to the text
            last_element.text = (last_element.text or '') + data
        else:
            last_element.tail = (last_element.tail or '') + data

    ignorableWhitespace = characters

    # Allow subscripting sax.ElementTreeContentHandler in type annotions (PEP 560)
    def __class_getitem__(cls, item):
        return _GenericAlias(cls, item)


class ElementTreeProducer:
    """Produces SAX events for an element and children.
    """
    def __init__(self, element_or_tree, content_handler):
        try:
            element = element_or_tree.getroot()
        except AttributeError:
            element = element_or_tree
        self._element = element
        self._content_handler = content_handler
        from xml.sax.xmlreader import AttributesNSImpl as attr_class
        self._attr_class = attr_class
        self._empty_attributes = attr_class({}, {})

    def saxify(self):
        self._content_handler.startDocument()

        element = self._element
        if hasattr(element, 'getprevious'):
            siblings = []
            sibling = element.getprevious()
            while getattr(sibling, 'tag', None) is ProcessingInstruction:
                siblings.append(sibling)
                sibling = sibling.getprevious()
            for sibling in siblings[::-1]:
                self._recursive_saxify(sibling, {})

        self._recursive_saxify(element, {})

        if hasattr(element, 'getnext'):
            sibling = element.getnext()
            while getattr(sibling, 'tag', None) is ProcessingInstruction:
                self._recursive_saxify(sibling, {})
                sibling = sibling.getnext()

        self._content_handler.endDocument()

    def _recursive_saxify(self, element, parent_nsmap):
        content_handler = self._content_handler
        tag = element.tag
        if tag is Comment or tag is ProcessingInstruction:
            if tag is ProcessingInstruction:
                content_handler.processingInstruction(
                    element.target, element.text)
            tail = element.tail
            if tail:
                content_handler.characters(tail)
            return

        element_nsmap = element.nsmap
        new_prefixes = []
        if element_nsmap != parent_nsmap:
            # There have been updates to the namespace
            for prefix, ns_uri in element_nsmap.items():
                if parent_nsmap.get(prefix) != ns_uri:
                    new_prefixes.append( (prefix, ns_uri) )

        attribs = element.items()
        if attribs:
            attr_values = {}
            attr_qnames = {}
            for attr_ns_name, value in attribs:
                attr_ns_tuple = _getNsTag(attr_ns_name)
                attr_values[attr_ns_tuple] = value
                attr_qnames[attr_ns_tuple] = self._build_qname(
                    attr_ns_tuple[0], attr_ns_tuple[1], element_nsmap,
                    preferred_prefix=None, is_attribute=True)
            sax_attributes = self._attr_class(attr_values, attr_qnames)
        else:
            sax_attributes = self._empty_attributes

        ns_uri, local_name = _getNsTag(tag)
        qname = self._build_qname(
            ns_uri, local_name, element_nsmap, element.prefix, is_attribute=False)

        for prefix, uri in new_prefixes:
            content_handler.startPrefixMapping(prefix, uri)
        content_handler.startElementNS(
            (ns_uri, local_name), qname, sax_attributes)
        text = element.text
        if text:
            content_handler.characters(text)
        for child in element:
            self._recursive_saxify(child, element_nsmap)
        content_handler.endElementNS((ns_uri, local_name), qname)
        for prefix, uri in new_prefixes:
            content_handler.endPrefixMapping(prefix)
        tail = element.tail
        if tail:
            content_handler.characters(tail)

    def _build_qname(self, ns_uri, local_name, nsmap, preferred_prefix, is_attribute):
        if ns_uri is None:
            return local_name

        if not is_attribute and nsmap.get(preferred_prefix) == ns_uri:
            prefix = preferred_prefix
        else:
            # Pick the first matching prefix, in alphabetical order.
            candidates = [
                pfx for (pfx, uri) in nsmap.items()
                if pfx is not None and uri == ns_uri
            ]
            prefix = (
                candidates[0] if len(candidates) == 1
                else min(candidates) if candidates
                else None
            )

        if prefix is None:
            # Default namespace
            return local_name
        return prefix + ':' + local_name


def saxify(element_or_tree, content_handler):
    """One-shot helper to generate SAX events from an XML tree and fire
    them against a SAX ContentHandler.
    """
    return ElementTreeProducer(element_or_tree, content_handler).saxify()
