"""
Legacy module - don't use in new code!

html5lib now has its own proper implementation.

This module implements a tree builder for html5lib that generates lxml
html element trees.  This module uses camelCase as it follows the
html5lib style guide.
"""

from html5lib.treebuilders import _base, etree as etree_builders
from lxml import html, etree


class DocumentType:

    def __init__(self, name, publicId, systemId):
        self.name = name
        self.publicId = publicId
        self.systemId = systemId

class Document:

    def __init__(self):
        self._elementTree = None
        self.childNodes = []

    def appendChild(self, element):
        self._elementTree.getroot().addnext(element._element)


class TreeBuilder(_base.TreeBuilder):
    documentClass = Document
    doctypeClass = DocumentType
    elementClass = None
    commentClass = None
    fragmentClass = Document

    def __init__(self, *args, **kwargs):
        html_builder = etree_builders.getETreeModule(html, fullTree=False)
        etree_builder = etree_builders.getETreeModule(etree, fullTree=False)
        self.elementClass = html_builder.Element
        self.commentClass = etree_builder.Comment
        _base.TreeBuilder.__init__(self, *args, **kwargs)

    def reset(self):
        _base.TreeBuilder.reset(self)
        self.rootInserted = False
        self.initialComments = []
        self.doctype = None

    def getDocument(self):
        return self.document._elementTree

    def getFragment(self):
        fragment = []
        element = self.openElements[0]._element
        if element.text:
            fragment.append(element.text)
        fragment.extend(element.getchildren())
        if element.tail:
            fragment.append(element.tail)
        return fragment

    def insertDoctype(self, name, publicId, systemId):
        doctype = self.doctypeClass(name, publicId, systemId)
        self.doctype = doctype

    def insertComment(self, data, parent=None):
        if not self.rootInserted:
            self.initialComments.append(data)
        else:
            _base.TreeBuilder.insertComment(self, data, parent)

    def insertRoot(self, name):
        buf = []
        if self.doctype and self.doctype.name:
            buf.append('<!DOCTYPE %s' % self.doctype.name)
            if self.doctype.publicId is not None or self.doctype.systemId is not None:
                buf.append(' PUBLIC "%s" "%s"' % (self.doctype.publicId,
                                                  self.doctype.systemId))
            buf.append('>')
        buf.append('<html></html>')
        root = html.fromstring(''.join(buf))

        # Append the initial comments:
        for comment in self.initialComments:
            root.addprevious(etree.Comment(comment))

        # Create the root document and add the ElementTree to it
        self.document = self.documentClass()
        self.document._elementTree = root.getroottree()

        # Add the root element to the internal child/open data structures
        root_element = self.elementClass(name)
        root_element._element = root
        self.document.childNodes.append(root_element)
        self.openElements.append(root_element)

        self.rootInserted = True
