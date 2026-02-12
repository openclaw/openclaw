# Copyright (c) 2004 Ian Bicking. All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are
# met:
#
# 1. Redistributions of source code must retain the above copyright
# notice, this list of conditions and the following disclaimer.
#
# 2. Redistributions in binary form must reproduce the above copyright
# notice, this list of conditions and the following disclaimer in
# the documentation and/or other materials provided with the
# distribution.
#
# 3. Neither the name of Ian Bicking nor the names of its contributors may
# be used to endorse or promote products derived from this software
# without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
# "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
# LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
# A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL IAN BICKING OR
# CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
# EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
# PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
# PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
# LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
# NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
# SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

"""The ``lxml.html`` tool set for HTML handling.
"""


__all__ = [
    'document_fromstring', 'fragment_fromstring', 'fragments_fromstring', 'fromstring',
    'tostring', 'Element', 'defs', 'open_in_browser', 'submit_form',
    'find_rel_links', 'find_class', 'make_links_absolute',
    'resolve_base_href', 'iterlinks', 'rewrite_links', 'parse']


import copy
import re

from collections.abc import MutableMapping, MutableSet
from functools import partial
from urllib.parse import urljoin

from .. import etree
from . import defs
from ._setmixin import SetMixin


def __fix_docstring(s):
    # TODO: remove and clean up doctests
    if not s:
        return s
    sub = re.compile(r"^(\s*)u'", re.M).sub
    return sub(r"\1'", s)


XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml"

_rel_links_xpath = etree.XPath("descendant-or-self::a[@rel]|descendant-or-self::x:a[@rel]",
                               namespaces={'x':XHTML_NAMESPACE})
_options_xpath = etree.XPath("descendant-or-self::option|descendant-or-self::x:option",
                             namespaces={'x':XHTML_NAMESPACE})
_forms_xpath = etree.XPath("descendant-or-self::form|descendant-or-self::x:form",
                           namespaces={'x':XHTML_NAMESPACE})
#_class_xpath = etree.XPath(r"descendant-or-self::*[regexp:match(@class, concat('\b', $class_name, '\b'))]", {'regexp': 'http://exslt.org/regular-expressions'})
_class_xpath = etree.XPath("descendant-or-self::*[@class and contains(concat(' ', normalize-space(@class), ' '), concat(' ', $class_name, ' '))]")
_id_xpath = etree.XPath("descendant-or-self::*[@id=$id]")
_collect_string_content = etree.XPath("string()", smart_strings=False)
_iter_css_urls = re.compile(r'url\(('+'["][^"]*["]|'+"['][^']*[']|"+r'[^)]*)\)', re.I).finditer
_iter_css_imports = re.compile(r'@import "(.*?)"').finditer
_label_xpath = etree.XPath("//label[@for=$id]|//x:label[@for=$id]",
                           namespaces={'x':XHTML_NAMESPACE})
_archive_re = re.compile(r'[^ ]+')
_parse_meta_refresh_url = re.compile(
    r'[^;=]*;\s*(?:url\s*=\s*)?(?P<url>.*)$', re.I).search


def _unquote_match(s, pos):
    if s[:1] == '"' and s[-1:] == '"' or s[:1] == "'" and s[-1:] == "'":
        return s[1:-1], pos+1
    else:
        return s,pos


def _transform_result(typ, result):
    """Convert the result back into the input type.
    """
    if issubclass(typ, bytes):
        return tostring(result, encoding='utf-8')
    elif issubclass(typ, str):
        return tostring(result, encoding='unicode')
    else:
        return result


def _nons(tag):
    if isinstance(tag, str):
        if tag[0] == '{' and tag[1:len(XHTML_NAMESPACE)+1] == XHTML_NAMESPACE:
            return tag.split('}')[-1]
    return tag


class Classes(MutableSet):
    """Provides access to an element's class attribute as a set-like collection.
    Usage::

        >>> el = fromstring('<p class="hidden large">Text</p>')
        >>> classes = el.classes  # or: classes = Classes(el.attrib)
        >>> classes |= ['block', 'paragraph']
        >>> el.get('class')
        'hidden large block paragraph'
        >>> classes.toggle('hidden')
        False
        >>> el.get('class')
        'large block paragraph'
        >>> classes -= ('some', 'classes', 'block')
        >>> el.get('class')
        'large paragraph'
    """
    def __init__(self, attributes):
        self._attributes = attributes
        self._get_class_value = partial(attributes.get, 'class', '')

    def add(self, value):
        """
        Add a class.

        This has no effect if the class is already present.
        """
        if not value or re.search(r'\s', value):
            raise ValueError("Invalid class name: %r" % value)
        classes = self._get_class_value().split()
        if value in classes:
            return
        classes.append(value)
        self._attributes['class'] = ' '.join(classes)

    def discard(self, value):
        """
        Remove a class if it is currently present.

        If the class is not present, do nothing.
        """
        if not value or re.search(r'\s', value):
            raise ValueError("Invalid class name: %r" % value)
        classes = [name for name in self._get_class_value().split()
                   if name != value]
        if classes:
            self._attributes['class'] = ' '.join(classes)
        elif 'class' in self._attributes:
            del self._attributes['class']

    def remove(self, value):
        """
        Remove a class; it must currently be present.

        If the class is not present, raise a KeyError.
        """
        if not value or re.search(r'\s', value):
            raise ValueError("Invalid class name: %r" % value)
        super().remove(value)

    def __contains__(self, name):
        classes = self._get_class_value()
        return name in classes and name in classes.split()

    def __iter__(self):
        return iter(self._get_class_value().split())

    def __len__(self):
        return len(self._get_class_value().split())

    # non-standard methods

    def update(self, values):
        """
        Add all names from 'values'.
        """
        classes = self._get_class_value().split()
        extended = False
        for value in values:
            if value not in classes:
                classes.append(value)
                extended = True
        if extended:
            self._attributes['class'] = ' '.join(classes)

    def toggle(self, value):
        """
        Add a class name if it isn't there yet, or remove it if it exists.

        Returns true if the class was added (and is now enabled) and
        false if it was removed (and is now disabled).
        """
        if not value or re.search(r'\s', value):
            raise ValueError("Invalid class name: %r" % value)
        classes = self._get_class_value().split()
        try:
            classes.remove(value)
            enabled = False
        except ValueError:
            classes.append(value)
            enabled = True
        if classes:
            self._attributes['class'] = ' '.join(classes)
        else:
            del self._attributes['class']
        return enabled


class HtmlMixin:

    def set(self, key, value=None):
        """set(self, key, value=None)

        Sets an element attribute.  If no value is provided, or if the value is None,
        creates a 'boolean' attribute without value, e.g. "<form novalidate></form>"
        for ``form.set('novalidate')``.
        """
        super().set(key, value)

    @property
    def classes(self):
        """
        A set-like wrapper around the 'class' attribute.
        """
        return Classes(self.attrib)

    @classes.setter
    def classes(self, classes):
        assert isinstance(classes, Classes)  # only allow "el.classes |= ..." etc.
        value = classes._get_class_value()
        if value:
            self.set('class', value)
        elif self.get('class') is not None:
            del self.attrib['class']

    @property
    def base_url(self):
        """
        Returns the base URL, given when the page was parsed.

        Use with ``urlparse.urljoin(el.base_url, href)`` to get
        absolute URLs.
        """
        return self.getroottree().docinfo.URL

    @property
    def forms(self):
        """
        Return a list of all the forms
        """
        return _forms_xpath(self)

    @property
    def body(self):
        """
        Return the <body> element.  Can be called from a child element
        to get the document's head.
        """
        for element in self.getroottree().iter("body", f"{{{XHTML_NAMESPACE}}}body"):
            return element
        return None

    @property
    def head(self):
        """
        Returns the <head> element.  Can be called from a child
        element to get the document's head.
        """
        for element in self.getroottree().iter("head", f"{{{XHTML_NAMESPACE}}}head"):
            return element
        return None

    @property
    def label(self):
        """
        Get or set any <label> element associated with this element.
        """
        id = self.get('id')
        if not id:
            return None
        result = _label_xpath(self, id=id)
        if not result:
            return None
        else:
            return result[0]

    @label.setter
    def label(self, label):
        id = self.get('id')
        if not id:
            raise TypeError(
                "You cannot set a label for an element (%r) that has no id"
                % self)
        if _nons(label.tag) != 'label':
            raise TypeError(
                "You can only assign label to a label element (not %r)"
                % label)
        label.set('for', id)

    @label.deleter
    def label(self):
        label = self.label
        if label is not None:
            del label.attrib['for']

    def drop_tree(self):
        """
        Removes this element from the tree, including its children and
        text.  The tail text is joined to the previous element or
        parent.
        """
        parent = self.getparent()
        assert parent is not None
        if self.tail:
            previous = self.getprevious()
            if previous is None:
                parent.text = (parent.text or '') + self.tail
            else:
                previous.tail = (previous.tail or '') + self.tail
        parent.remove(self)

    def drop_tag(self):
        """
        Remove the tag, but not its children or text.  The children and text
        are merged into the parent.

        Example::

            >>> h = fragment_fromstring('<div>Hello <b>World!</b></div>')
            >>> h.find('.//b').drop_tag()
            >>> print(tostring(h, encoding='unicode'))
            <div>Hello World!</div>
        """
        parent = self.getparent()
        assert parent is not None
        previous = self.getprevious()
        if self.text and isinstance(self.tag, str):
            # not a Comment, etc.
            if previous is None:
                parent.text = (parent.text or '') + self.text
            else:
                previous.tail = (previous.tail or '') + self.text
        if self.tail:
            if len(self):
                last = self[-1]
                last.tail = (last.tail or '') + self.tail
            elif previous is None:
                parent.text = (parent.text or '') + self.tail
            else:
                previous.tail = (previous.tail or '') + self.tail
        index = parent.index(self)
        parent[index:index+1] = self[:]

    def find_rel_links(self, rel):
        """
        Find any links like ``<a rel="{rel}">...</a>``; returns a list of elements.
        """
        rel = rel.lower()
        return [el for el in _rel_links_xpath(self)
                if el.get('rel').lower() == rel]

    def find_class(self, class_name):
        """
        Find any elements with the given class name.
        """
        return _class_xpath(self, class_name=class_name)

    def get_element_by_id(self, id, *default):
        """
        Get the first element in a document with the given id.  If none is
        found, return the default argument if provided or raise KeyError
        otherwise.

        Note that there can be more than one element with the same id,
        and this isn't uncommon in HTML documents found in the wild.
        Browsers return only the first match, and this function does
        the same.
        """
        try:
            # FIXME: should this check for multiple matches?
            # browsers just return the first one
            return _id_xpath(self, id=id)[0]
        except IndexError:
            if default:
                return default[0]
            else:
                raise KeyError(id)

    def text_content(self):
        """
        Return the text content of the tag (and the text in any children).
        """
        return _collect_string_content(self)

    def cssselect(self, expr, translator='html'):
        """
        Run the CSS expression on this element and its children,
        returning a list of the results.

        Equivalent to lxml.cssselect.CSSSelect(expr, translator='html')(self)
        -- note that pre-compiling the expression can provide a substantial
        speedup.
        """
        # Do the import here to make the dependency optional.
        from lxml.cssselect import CSSSelector
        return CSSSelector(expr, translator=translator)(self)

    ########################################
    ## Link functions
    ########################################

    def make_links_absolute(self, base_url=None, resolve_base_href=True,
                            handle_failures=None):
        """
        Make all links in the document absolute, given the
        ``base_url`` for the document (the full URL where the document
        came from), or if no ``base_url`` is given, then the ``.base_url``
        of the document.

        If ``resolve_base_href`` is true, then any ``<base href>``
        tags in the document are used *and* removed from the document.
        If it is false then any such tag is ignored.

        If ``handle_failures`` is None (default), a failure to process
        a URL will abort the processing.  If set to 'ignore', errors
        are ignored.  If set to 'discard', failing URLs will be removed.
        """
        if base_url is None:
            base_url = self.base_url
            if base_url is None:
                raise TypeError(
                    "No base_url given, and the document has no base_url")
        if resolve_base_href:
            self.resolve_base_href()

        if handle_failures == 'ignore':
            def link_repl(href):
                try:
                    return urljoin(base_url, href)
                except ValueError:
                    return href
        elif handle_failures == 'discard':
            def link_repl(href):
                try:
                    return urljoin(base_url, href)
                except ValueError:
                    return None
        elif handle_failures is None:
            def link_repl(href):
                return urljoin(base_url, href)
        else:
            raise ValueError(
                "unexpected value for handle_failures: %r" % handle_failures)

        self.rewrite_links(link_repl)

    def resolve_base_href(self, handle_failures=None):
        """
        Find any ``<base href>`` tag in the document, and apply its
        values to all links found in the document.  Also remove the
        tag once it has been applied.

        If ``handle_failures`` is None (default), a failure to process
        a URL will abort the processing.  If set to 'ignore', errors
        are ignored.  If set to 'discard', failing URLs will be removed.
        """
        base_href = None
        basetags = self.xpath('//base[@href]|//x:base[@href]',
                              namespaces={'x': XHTML_NAMESPACE})
        for b in basetags:
            base_href = b.get('href')
            b.drop_tree()
        if not base_href:
            return
        self.make_links_absolute(base_href, resolve_base_href=False,
                                 handle_failures=handle_failures)

    def iterlinks(self):
        """
        Yield (element, attribute, link, pos), where attribute may be None
        (indicating the link is in the text).  ``pos`` is the position
        where the link occurs; often 0, but sometimes something else in
        the case of links in stylesheets or style tags.

        Note: <base href> is *not* taken into account in any way.  The
        link you get is exactly the link in the document.

        Note: multiple links inside of a single text string or
        attribute value are returned in reversed order.  This makes it
        possible to replace or delete them from the text string value
        based on their reported text positions.  Otherwise, a
        modification at one text position can change the positions of
        links reported later on.
        """
        link_attrs = defs.link_attrs
        for el in self.iter(etree.Element):
            attribs = el.attrib
            tag = _nons(el.tag)
            if tag == 'object':
                codebase = None
                ## <object> tags have attributes that are relative to
                ## codebase
                if 'codebase' in attribs:
                    codebase = el.get('codebase')
                    yield (el, 'codebase', codebase, 0)
                for attrib in ('classid', 'data'):
                    if attrib in attribs:
                        value = el.get(attrib)
                        if codebase is not None:
                            value = urljoin(codebase, value)
                        yield (el, attrib, value, 0)
                if 'archive' in attribs:
                    for match in _archive_re.finditer(el.get('archive')):
                        value = match.group(0)
                        if codebase is not None:
                            value = urljoin(codebase, value)
                        yield (el, 'archive', value, match.start())
            else:
                for attrib in link_attrs:
                    if attrib in attribs:
                        yield (el, attrib, attribs[attrib], 0)
            if tag == 'meta':
                http_equiv = attribs.get('http-equiv', '').lower()
                if http_equiv == 'refresh':
                    content = attribs.get('content', '')
                    match = _parse_meta_refresh_url(content)
                    url = (match.group('url') if match else content).strip()
                    # unexpected content means the redirect won't work, but we might
                    # as well be permissive and return the entire string.
                    if url:
                        url, pos = _unquote_match(
                            url, match.start('url') if match else content.find(url))
                        yield (el, 'content', url, pos)
            elif tag == 'param':
                valuetype = el.get('valuetype') or ''
                if valuetype.lower() == 'ref':
                    ## FIXME: while it's fine we *find* this link,
                    ## according to the spec we aren't supposed to
                    ## actually change the value, including resolving
                    ## it.  It can also still be a link, even if it
                    ## doesn't have a valuetype="ref" (which seems to be the norm)
                    ## http://www.w3.org/TR/html401/struct/objects.html#adef-valuetype
                    yield (el, 'value', el.get('value'), 0)
            elif tag == 'style' and el.text:
                urls = [
                    # (start_pos, url)
                    _unquote_match(match.group(1), match.start(1))[::-1]
                    for match in _iter_css_urls(el.text)
                    ] + [
                    (match.start(1), match.group(1))
                    for match in _iter_css_imports(el.text)
                    ]
                if urls:
                    # sort by start pos to bring both match sets back into order
                    # and reverse the list to report correct positions despite
                    # modifications
                    urls.sort(reverse=True)
                    for start, url in urls:
                        yield (el, None, url, start)
            if 'style' in attribs:
                urls = list(_iter_css_urls(attribs['style']))
                if urls:
                    # return in reversed order to simplify in-place modifications
                    for match in urls[::-1]:
                        url, start = _unquote_match(match.group(1), match.start(1))
                        yield (el, 'style', url, start)

    def rewrite_links(self, link_repl_func, resolve_base_href=True,
                      base_href=None):
        """
        Rewrite all the links in the document.  For each link
        ``link_repl_func(link)`` will be called, and the return value
        will replace the old link.

        Note that links may not be absolute (unless you first called
        ``make_links_absolute()``), and may be internal (e.g.,
        ``'#anchor'``).  They can also be values like
        ``'mailto:email'`` or ``'javascript:expr'``.

        If you give ``base_href`` then all links passed to
        ``link_repl_func()`` will take that into account.

        If the ``link_repl_func`` returns None, the attribute or
        tag text will be removed completely.
        """
        if base_href is not None:
            # FIXME: this can be done in one pass with a wrapper
            # around link_repl_func
            self.make_links_absolute(
                base_href, resolve_base_href=resolve_base_href)
        elif resolve_base_href:
            self.resolve_base_href()

        for el, attrib, link, pos in self.iterlinks():
            new_link = link_repl_func(link.strip())
            if new_link == link:
                continue
            if new_link is None:
                # Remove the attribute or element content
                if attrib is None:
                    el.text = ''
                else:
                    del el.attrib[attrib]
                continue

            if attrib is None:
                new = el.text[:pos] + new_link + el.text[pos+len(link):]
                el.text = new
            else:
                cur = el.get(attrib)
                if not pos and len(cur) == len(link):
                    new = new_link  # most common case
                else:
                    new = cur[:pos] + new_link + cur[pos+len(link):]
                el.set(attrib, new)


class _MethodFunc:
    """
    An object that represents a method on an element as a function;
    the function takes either an element or an HTML string.  It
    returns whatever the function normally returns, or if the function
    works in-place (and so returns None) it returns a serialized form
    of the resulting document.
    """
    def __init__(self, name, copy=False, source_class=HtmlMixin):
        self.name = name
        self.copy = copy
        self.__doc__ = getattr(source_class, self.name).__doc__
    def __call__(self, doc, *args, **kw):
        result_type = type(doc)
        if isinstance(doc, (str, bytes)):
            if 'copy' in kw:
                raise TypeError(
                    "The keyword 'copy' can only be used with element inputs to %s, not a string input" % self.name)
            doc = fromstring(doc, **kw)
        else:
            if 'copy' in kw:
                make_a_copy = kw.pop('copy')
            else:
                make_a_copy = self.copy
            if make_a_copy:
                doc = copy.deepcopy(doc)
        meth = getattr(doc, self.name)
        result = meth(*args, **kw)
        # FIXME: this None test is a bit sloppy
        if result is None:
            # Then return what we got in
            return _transform_result(result_type, doc)
        else:
            return result


find_rel_links = _MethodFunc('find_rel_links', copy=False)
find_class = _MethodFunc('find_class', copy=False)
make_links_absolute = _MethodFunc('make_links_absolute', copy=True)
resolve_base_href = _MethodFunc('resolve_base_href', copy=True)
iterlinks = _MethodFunc('iterlinks', copy=False)
rewrite_links = _MethodFunc('rewrite_links', copy=True)


class HtmlComment(HtmlMixin, etree.CommentBase):
    pass


class HtmlElement(HtmlMixin, etree.ElementBase):
    pass


class HtmlProcessingInstruction(HtmlMixin, etree.PIBase):
    pass


class HtmlEntity(HtmlMixin, etree.EntityBase):
    pass


class HtmlElementClassLookup(etree.CustomElementClassLookup):
    """A lookup scheme for HTML Element classes.

    To create a lookup instance with different Element classes, pass a tag
    name mapping of Element classes in the ``classes`` keyword argument and/or
    a tag name mapping of Mixin classes in the ``mixins`` keyword argument.
    The special key '*' denotes a Mixin class that should be mixed into all
    Element classes.
    """
    _default_element_classes = {}

    def __init__(self, classes=None, mixins=None):
        etree.CustomElementClassLookup.__init__(self)
        if classes is None:
            classes = self._default_element_classes.copy()
        if mixins:
            mixers = {}
            for name, value in mixins:
                if name == '*':
                    for n in classes.keys():
                        mixers.setdefault(n, []).append(value)
                else:
                    mixers.setdefault(name, []).append(value)
            for name, mix_bases in mixers.items():
                cur = classes.get(name, HtmlElement)
                bases = tuple(mix_bases + [cur])
                classes[name] = type(cur.__name__, bases, {})
        self._element_classes = classes

    def lookup(self, node_type, document, namespace, name):
        if node_type == 'element':
            return self._element_classes.get(name.lower(), HtmlElement)
        elif node_type == 'comment':
            return HtmlComment
        elif node_type == 'PI':
            return HtmlProcessingInstruction
        elif node_type == 'entity':
            return HtmlEntity
        # Otherwise normal lookup
        return None


################################################################################
# parsing
################################################################################

_looks_like_full_html_unicode = re.compile(
    r'^\s*<(?:html|!doctype)', re.I).match
_looks_like_full_html_bytes = re.compile(
    br'^\s*<(?:html|!doctype)', re.I).match


def document_fromstring(html, parser=None, ensure_head_body=False, **kw):
    if parser is None:
        parser = html_parser
    value = etree.fromstring(html, parser, **kw)
    if value is None:
        raise etree.ParserError(
            "Document is empty")
    if ensure_head_body and value.find('head') is None:
        value.insert(0, Element('head'))
    if ensure_head_body and value.find('body') is None:
        value.append(Element('body'))
    return value


def fragments_fromstring(html, no_leading_text=False, base_url=None,
                         parser=None, **kw):
    """Parses several HTML elements, returning a list of elements.

    The first item in the list may be a string.
    If no_leading_text is true, then it will be an error if there is
    leading text, and it will always be a list of only elements.

    base_url will set the document's base_url attribute
    (and the tree's docinfo.URL).
    """
    if parser is None:
        parser = html_parser
    # FIXME: check what happens when you give html with a body, head, etc.
    if isinstance(html, bytes):
        if not _looks_like_full_html_bytes(html):
            # can't use %-formatting in early Py3 versions
            html = (b'<html><body>' + html +
                    b'</body></html>')
    else:
        if not _looks_like_full_html_unicode(html):
            html = '<html><body>%s</body></html>' % html
    doc = document_fromstring(html, parser=parser, base_url=base_url, **kw)
    assert _nons(doc.tag) == 'html'
    bodies = [e for e in doc if _nons(e.tag) == 'body']
    assert len(bodies) == 1, ("too many bodies: %r in %r" % (bodies, html))
    body = bodies[0]
    elements = []
    if no_leading_text and body.text and body.text.strip():
        raise etree.ParserError(
            "There is leading text: %r" % body.text)
    if body.text and body.text.strip():
        elements.append(body.text)
    elements.extend(body)
    # FIXME: removing the reference to the parent artificial document
    # would be nice
    return elements


def fragment_fromstring(html, create_parent=False, base_url=None,
                        parser=None, **kw):
    """
    Parses a single HTML element; it is an error if there is more than
    one element, or if anything but whitespace precedes or follows the
    element.

    If ``create_parent`` is true (or is a tag name) then a parent node
    will be created to encapsulate the HTML in a single element.  In this
    case, leading or trailing text is also allowed, as are multiple elements
    as result of the parsing.

    Passing a ``base_url`` will set the document's ``base_url`` attribute
    (and the tree's docinfo.URL).
    """
    if parser is None:
        parser = html_parser

    accept_leading_text = bool(create_parent)

    elements = fragments_fromstring(
        html, parser=parser, no_leading_text=not accept_leading_text,
        base_url=base_url, **kw)

    if create_parent:
        if not isinstance(create_parent, str):
            create_parent = 'div'
        new_root = Element(create_parent)
        if elements:
            if isinstance(elements[0], str):
                new_root.text = elements[0]
                del elements[0]
            new_root.extend(elements)
        return new_root

    if not elements:
        raise etree.ParserError('No elements found')
    if len(elements) > 1:
        raise etree.ParserError(
            "Multiple elements found (%s)"
            % ', '.join([_element_name(e) for e in elements]))
    el = elements[0]
    if el.tail and el.tail.strip():
        raise etree.ParserError(
            "Element followed by text: %r" % el.tail)
    el.tail = None
    return el


def fromstring(html, base_url=None, parser=None, **kw):
    """
    Parse the html, returning a single element/document.

    This tries to minimally parse the chunk of text, without knowing if it
    is a fragment or a document.

    base_url will set the document's base_url attribute (and the tree's docinfo.URL)
    """
    if parser is None:
        parser = html_parser
    if isinstance(html, bytes):
        is_full_html = _looks_like_full_html_bytes(html)
    else:
        is_full_html = _looks_like_full_html_unicode(html)
    doc = document_fromstring(html, parser=parser, base_url=base_url, **kw)
    if is_full_html:
        return doc
    # otherwise, lets parse it out...
    bodies = doc.findall('body')
    if not bodies:
        bodies = doc.findall('{%s}body' % XHTML_NAMESPACE)
    if bodies:
        body = bodies[0]
        if len(bodies) > 1:
            # Somehow there are multiple bodies, which is bad, but just
            # smash them into one body
            for other_body in bodies[1:]:
                if other_body.text:
                    if len(body):
                        body[-1].tail = (body[-1].tail or '') + other_body.text
                    else:
                        body.text = (body.text or '') + other_body.text
                body.extend(other_body)
                # We'll ignore tail
                # I guess we are ignoring attributes too
                other_body.drop_tree()
    else:
        body = None
    heads = doc.findall('head')
    if not heads:
        heads = doc.findall('{%s}head' % XHTML_NAMESPACE)
    if heads:
        # Well, we have some sort of structure, so lets keep it all
        head = heads[0]
        if len(heads) > 1:
            for other_head in heads[1:]:
                head.extend(other_head)
                # We don't care about text or tail in a head
                other_head.drop_tree()
        return doc
    if body is None:
        return doc
    if (len(body) == 1 and (not body.text or not body.text.strip())
        and (not body[-1].tail or not body[-1].tail.strip())):
        # The body has just one element, so it was probably a single
        # element passed in
        return body[0]
    # Now we have a body which represents a bunch of tags which have the
    # content that was passed in.  We will create a fake container, which
    # is the body tag, except <body> implies too much structure.
    if _contains_block_level_tag(body):
        body.tag = 'div'
    else:
        body.tag = 'span'
    return body


def parse(filename_or_url, parser=None, base_url=None, **kw):
    """
    Parse a filename, URL, or file-like object into an HTML document
    tree.  Note: this returns a tree, not an element.  Use
    ``parse(...).getroot()`` to get the document root.

    You can override the base URL with the ``base_url`` keyword.  This
    is most useful when parsing from a file-like object.
    """
    if parser is None:
        parser = html_parser
    return etree.parse(filename_or_url, parser, base_url=base_url, **kw)


def _contains_block_level_tag(el):
    # FIXME: I could do this with XPath, but would that just be
    # unnecessarily slow?
    for el in el.iter(etree.Element):
        if _nons(el.tag) in defs.block_tags:
            return True
    return False


def _element_name(el):
    if isinstance(el, etree.CommentBase):
        return 'comment'
    elif isinstance(el, str):
        return 'string'
    else:
        return _nons(el.tag)


################################################################################
# form handling
################################################################################

class FormElement(HtmlElement):
    """
    Represents a <form> element.
    """

    @property
    def inputs(self):
        """
        Returns an accessor for all the input elements in the form.

        See `InputGetter` for more information about the object.
        """
        return InputGetter(self)

    @property
    def fields(self):
        """
        Dictionary-like object that represents all the fields in this
        form.  You can set values in this dictionary to effect the
        form.
        """
        return FieldsDict(self.inputs)

    @fields.setter
    def fields(self, value):
        fields = self.fields
        prev_keys = fields.keys()
        for key, value in value.items():
            if key in prev_keys:
                prev_keys.remove(key)
            fields[key] = value
        for key in prev_keys:
            if key is None:
                # Case of an unnamed input; these aren't really
                # expressed in form_values() anyway.
                continue
            fields[key] = None

    def _name(self):
        if self.get('name'):
            return self.get('name')
        elif self.get('id'):
            return '#' + self.get('id')
        iter_tags = self.body.iter
        forms = list(iter_tags('form'))
        if not forms:
            forms = list(iter_tags('{%s}form' % XHTML_NAMESPACE))
        return str(forms.index(self))

    def form_values(self):
        """
        Return a list of tuples of the field values for the form.
        This is suitable to be passed to ``urllib.urlencode()``.
        """
        results = []
        for el in self.inputs:
            name = el.name
            if not name or 'disabled' in el.attrib:
                continue
            tag = _nons(el.tag)
            if tag == 'textarea':
                results.append((name, el.value))
            elif tag == 'select':
                value = el.value
                if el.multiple:
                    for v in value:
                        results.append((name, v))
                elif value is not None:
                    results.append((name, el.value))
            else:
                assert tag == 'input', (
                    "Unexpected tag: %r" % el)
                if el.checkable and not el.checked:
                    continue
                if el.type in ('submit', 'image', 'reset', 'file'):
                    continue
                value = el.value
                if value is not None:
                    results.append((name, el.value))
        return results

    @property
    def action(self):
        """
        Get/set the form's ``action`` attribute.
        """
        base_url = self.base_url
        action = self.get('action')
        if base_url and action is not None:
            return urljoin(base_url, action)
        else:
            return action

    @action.setter
    def action(self, value):
        self.set('action', value)

    @action.deleter
    def action(self):
        attrib = self.attrib
        if 'action' in attrib:
            del attrib['action']

    @property
    def method(self):
        """
        Get/set the form's method.  Always returns a capitalized
        string, and defaults to ``'GET'``
        """
        return self.get('method', 'GET').upper()

    @method.setter
    def method(self, value):
        self.set('method', value.upper())


HtmlElementClassLookup._default_element_classes['form'] = FormElement


def submit_form(form, extra_values=None, open_http=None):
    """
    Helper function to submit a form.  Returns a file-like object, as from
    ``urllib.urlopen()``.  This object also has a ``.geturl()`` function,
    which shows the URL if there were any redirects.

    You can use this like::

        form = doc.forms[0]
        form.inputs['foo'].value = 'bar' # etc
        response = form.submit()
        doc = parse(response)
        doc.make_links_absolute(response.geturl())

    To change the HTTP requester, pass a function as ``open_http`` keyword
    argument that opens the URL for you.  The function must have the following
    signature::

        open_http(method, URL, values)

    The action is one of 'GET' or 'POST', the URL is the target URL as a
    string, and the values are a sequence of ``(name, value)`` tuples with the
    form data.
    """
    values = form.form_values()
    if extra_values:
        if hasattr(extra_values, 'items'):
            extra_values = extra_values.items()
        values.extend(extra_values)
    if open_http is None:
        open_http = open_http_urllib
    if form.action:
        url = form.action
    else:
        url = form.base_url
    return open_http(form.method, url, values)


def open_http_urllib(method, url, values):
    if not url:
        raise ValueError("cannot submit, no URL provided")
    ## FIXME: should test that it's not a relative URL or something
    try:
        from urllib import urlencode, urlopen
    except ImportError: # Python 3
        from urllib.request import urlopen
        from urllib.parse import urlencode
    if method == 'GET':
        if '?' in url:
            url += '&'
        else:
            url += '?'
        url += urlencode(values)
        data = None
    else:
        data = urlencode(values)
        if not isinstance(data, bytes):
            data = data.encode('ASCII')
    return urlopen(url, data)


class FieldsDict(MutableMapping):

    def __init__(self, inputs):
        self.inputs = inputs
    def __getitem__(self, item):
        return self.inputs[item].value
    def __setitem__(self, item, value):
        self.inputs[item].value = value
    def __delitem__(self, item):
        raise KeyError(
            "You cannot remove keys from ElementDict")
    def keys(self):
        return self.inputs.keys()
    def __contains__(self, item):
        return item in self.inputs
    def __iter__(self):
        return iter(self.inputs.keys())
    def __len__(self):
        return len(self.inputs)

    def __repr__(self):
        return '<%s for form %s>' % (
            self.__class__.__name__,
            self.inputs.form._name())


class InputGetter:

    """
    An accessor that represents all the input fields in a form.

    You can get fields by name from this, with
    ``form.inputs['field_name']``.  If there are a set of checkboxes
    with the same name, they are returned as a list (a `CheckboxGroup`
    which also allows value setting).  Radio inputs are handled
    similarly.  Use ``.keys()`` and ``.items()`` to process all fields
    in this way.

    You can also iterate over this to get all input elements.  This
    won't return the same thing as if you get all the names, as
    checkboxes and radio elements are returned individually.
    """

    def __init__(self, form):
        self.form = form

    def __repr__(self):
        return '<%s for form %s>' % (
            self.__class__.__name__,
            self.form._name())

    ## FIXME: there should be more methods, and it's unclear if this is
    ## a dictionary-like object or list-like object

    def __getitem__(self, name):
        fields = [field for field in self if field.name == name]
        if not fields:
            raise KeyError("No input element with the name %r" % name)

        input_type = fields[0].get('type')
        if input_type == 'radio' and len(fields) > 1:
            group = RadioGroup(fields)
            group.name = name
            return group
        elif input_type == 'checkbox' and len(fields) > 1:
            group = CheckboxGroup(fields)
            group.name = name
            return group
        else:
            # I don't like throwing away elements like this
            return fields[0]

    def __contains__(self, name):
        for field in self:
            if field.name == name:
                return True
        return False

    def keys(self):
        """
        Returns all unique field names, in document order.

        :return: A list of all unique field names.
        """
        names = []
        seen = {None}
        for el in self:
            name = el.name
            if name not in seen:
                names.append(name)
                seen.add(name)
        return names

    def items(self):
        """
        Returns all fields with their names, similar to dict.items().

        :return: A list of (name, field) tuples.
        """
        items = []
        seen = set()
        for el in self:
            name = el.name
            if name not in seen:
                seen.add(name)
                items.append((name, self[name]))
        return items

    def __iter__(self):
        return self.form.iter('select', 'input', 'textarea')

    def __len__(self):
        return sum(1 for _ in self)


class InputMixin:
    """
    Mix-in for all input elements (input, select, and textarea)
    """
    @property
    def name(self):
        """
        Get/set the name of the element
        """
        return self.get('name')

    @name.setter
    def name(self, value):
        self.set('name', value)

    @name.deleter
    def name(self):
        attrib = self.attrib
        if 'name' in attrib:
            del attrib['name']

    def __repr__(self):
        type_name = getattr(self, 'type', None)
        if type_name:
            type_name = ' type=%r' % type_name
        else:
            type_name = ''
        return '<%s %x name=%r%s>' % (
            self.__class__.__name__, id(self), self.name, type_name)


class TextareaElement(InputMixin, HtmlElement):
    """
    ``<textarea>`` element.  You can get the name with ``.name`` and
    get/set the value with ``.value``
    """
    @property
    def value(self):
        """
        Get/set the value (which is the contents of this element)
        """
        content = self.text or ''
        if self.tag.startswith("{%s}" % XHTML_NAMESPACE):
            serialisation_method = 'xml'
        else:
            serialisation_method = 'html'
        for el in self:
            # it's rare that we actually get here, so let's not use ''.join()
            content += etree.tostring(
                el, method=serialisation_method, encoding='unicode')
        return content

    @value.setter
    def value(self, value):
        del self[:]
        self.text = value

    @value.deleter
    def value(self):
        self.text = ''
        del self[:]


HtmlElementClassLookup._default_element_classes['textarea'] = TextareaElement


class SelectElement(InputMixin, HtmlElement):
    """
    ``<select>`` element.  You can get the name with ``.name``.

    ``.value`` will be the value of the selected option, unless this
    is a multi-select element (``<select multiple>``), in which case
    it will be a set-like object.  In either case ``.value_options``
    gives the possible values.

    The boolean attribute ``.multiple`` shows if this is a
    multi-select.
    """
    @property
    def value(self):
        """
        Get/set the value of this select (the selected option).

        If this is a multi-select, this is a set-like object that
        represents all the selected options.
        """
        if self.multiple:
            return MultipleSelectOptions(self)
        options = _options_xpath(self)

        try:
            selected_option = next(el for el in reversed(options) if el.get('selected') is not None)
        except StopIteration:
            try:
                selected_option = next(el for el in options if el.get('disabled') is None)
            except StopIteration:
                return None
        value = selected_option.get('value')
        if value is None:
            value = (selected_option.text or '').strip()
        return value

    @value.setter
    def value(self, value):
        if self.multiple:
            if isinstance(value, str):
                raise TypeError("You must pass in a sequence")
            values = self.value
            values.clear()
            values.update(value)
            return
        checked_option = None
        if value is not None:
            for el in _options_xpath(self):
                opt_value = el.get('value')
                if opt_value is None:
                    opt_value = (el.text or '').strip()
                if opt_value == value:
                    checked_option = el
                    break
            else:
                raise ValueError(
                    "There is no option with the value of %r" % value)
        for el in _options_xpath(self):
            if 'selected' in el.attrib:
                del el.attrib['selected']
        if checked_option is not None:
            checked_option.set('selected', '')

    @value.deleter
    def value(self):
        # FIXME: should del be allowed at all?
        if self.multiple:
            self.value.clear()
        else:
            self.value = None

    @property
    def value_options(self):
        """
        All the possible values this select can have (the ``value``
        attribute of all the ``<option>`` elements.
        """
        options = []
        for el in _options_xpath(self):
            value = el.get('value')
            if value is None:
                value = (el.text or '').strip()
            options.append(value)
        return options

    @property
    def multiple(self):
        """
        Boolean attribute: is there a ``multiple`` attribute on this element.
        """
        return 'multiple' in self.attrib

    @multiple.setter
    def multiple(self, value):
        if value:
            self.set('multiple', '')
        elif 'multiple' in self.attrib:
            del self.attrib['multiple']


HtmlElementClassLookup._default_element_classes['select'] = SelectElement


class MultipleSelectOptions(SetMixin):
    """
    Represents all the selected options in a ``<select multiple>`` element.

    You can add to this set-like option to select an option, or remove
    to unselect the option.
    """

    def __init__(self, select):
        self.select = select

    @property
    def options(self):
        """
        Iterator of all the ``<option>`` elements.
        """
        return iter(_options_xpath(self.select))

    def __iter__(self):
        for option in self.options:
            if 'selected' in option.attrib:
                opt_value = option.get('value')
                if opt_value is None:
                    opt_value = (option.text or '').strip()
                yield opt_value

    def add(self, item):
        for option in self.options:
            opt_value = option.get('value')
            if opt_value is None:
                opt_value = (option.text or '').strip()
            if opt_value == item:
                option.set('selected', '')
                break
        else:
            raise ValueError(
                "There is no option with the value %r" % item)

    def remove(self, item):
        for option in self.options:
            opt_value = option.get('value')
            if opt_value is None:
                opt_value = (option.text or '').strip()
            if opt_value == item:
                if 'selected' in option.attrib:
                    del option.attrib['selected']
                else:
                    raise ValueError(
                        "The option %r is not currently selected" % item)
                break
        else:
            raise ValueError(
                "There is not option with the value %r" % item)

    def __repr__(self):
        return '<%s {%s} for select name=%r>' % (
            self.__class__.__name__,
            ', '.join([repr(v) for v in self]),
            self.select.name)


class RadioGroup(list):
    """
    This object represents several ``<input type=radio>`` elements
    that have the same name.

    You can use this like a list, but also use the property
    ``.value`` to check/uncheck inputs.  Also you can use
    ``.value_options`` to get the possible values.
    """
    @property
    def value(self):
        """
        Get/set the value, which checks the radio with that value (and
        unchecks any other value).
        """
        for el in self:
            if 'checked' in el.attrib:
                return el.get('value')
        return None

    @value.setter
    def value(self, value):
        checked_option = None
        if value is not None:
            for el in self:
                if el.get('value') == value:
                    checked_option = el
                    break
            else:
                raise ValueError("There is no radio input with the value %r" % value)
        for el in self:
            if 'checked' in el.attrib:
                del el.attrib['checked']
        if checked_option is not None:
            checked_option.set('checked', '')

    @value.deleter
    def value(self):
        self.value = None

    @property
    def value_options(self):
        """
        Returns a list of all the possible values.
        """
        return [el.get('value') for el in self]

    def __repr__(self):
        return '%s(%s)' % (
            self.__class__.__name__,
            list.__repr__(self))


class CheckboxGroup(list):
    """
    Represents a group of checkboxes (``<input type=checkbox>``) that
    have the same name.

    In addition to using this like a list, the ``.value`` attribute
    returns a set-like object that you can add to or remove from to
    check and uncheck checkboxes.  You can also use ``.value_options``
    to get the possible values.
    """
    @property
    def value(self):
        """
        Return a set-like object that can be modified to check or
        uncheck individual checkboxes according to their value.
        """
        return CheckboxValues(self)

    @value.setter
    def value(self, value):
        values = self.value
        values.clear()
        if not hasattr(value, '__iter__'):
            raise ValueError(
                "A CheckboxGroup (name=%r) must be set to a sequence (not %r)"
                % (self[0].name, value))
        values.update(value)

    @value.deleter
    def value(self):
        self.value.clear()

    @property
    def value_options(self):
        """
        Returns a list of all the possible values.
        """
        return [el.get('value') for el in self]

    def __repr__(self):
        return '%s(%s)' % (
            self.__class__.__name__, list.__repr__(self))


class CheckboxValues(SetMixin):
    """
    Represents the values of the checked checkboxes in a group of
    checkboxes with the same name.
    """

    def __init__(self, group):
        self.group = group

    def __iter__(self):
        return iter([
            el.get('value')
            for el in self.group
            if 'checked' in el.attrib])

    def add(self, value):
        for el in self.group:
            if el.get('value') == value:
                el.set('checked', '')
                break
        else:
            raise KeyError("No checkbox with value %r" % value)

    def remove(self, value):
        for el in self.group:
            if el.get('value') == value:
                if 'checked' in el.attrib:
                    del el.attrib['checked']
                else:
                    raise KeyError(
                        "The checkbox with value %r was already unchecked" % value)
                break
        else:
            raise KeyError(
                "No checkbox with value %r" % value)

    def __repr__(self):
        return '<%s {%s} for checkboxes name=%r>' % (
            self.__class__.__name__,
            ', '.join([repr(v) for v in self]),
            self.group.name)


class InputElement(InputMixin, HtmlElement):
    """
    Represents an ``<input>`` element.

    You can get the type with ``.type`` (which is lower-cased and
    defaults to ``'text'``).

    Also you can get and set the value with ``.value``

    Checkboxes and radios have the attribute ``input.checkable ==
    True`` (for all others it is false) and a boolean attribute
    ``.checked``.

    """

    ## FIXME: I'm a little uncomfortable with the use of .checked
    @property
    def value(self):
        """
        Get/set the value of this element, using the ``value`` attribute.

        Also, if this is a checkbox and it has no value, this defaults
        to ``'on'``.  If it is a checkbox or radio that is not
        checked, this returns None.
        """
        if self.checkable:
            if self.checked:
                return self.get('value') or 'on'
            else:
                return None
        return self.get('value')

    @value.setter
    def value(self, value):
        if self.checkable:
            if not value:
                self.checked = False
            else:
                self.checked = True
                if isinstance(value, str):
                    self.set('value', value)
        else:
            self.set('value', value)

    @value.deleter
    def value(self):
        if self.checkable:
            self.checked = False
        else:
            if 'value' in self.attrib:
                del self.attrib['value']

    @property
    def type(self):
        """
        Return the type of this element (using the type attribute).
        """
        return self.get('type', 'text').lower()

    @type.setter
    def type(self, value):
        self.set('type', value)

    @property
    def checkable(self):
        """
        Boolean: can this element be checked?
        """
        return self.type in ('checkbox', 'radio')

    @property
    def checked(self):
        """
        Boolean attribute to get/set the presence of the ``checked``
        attribute.

        You can only use this on checkable input types.
        """
        if not self.checkable:
            raise AttributeError('Not a checkable input type')
        return 'checked' in self.attrib

    @checked.setter
    def checked(self, value):
        if not self.checkable:
            raise AttributeError('Not a checkable input type')
        if value:
            self.set('checked', '')
        else:
            attrib = self.attrib
            if 'checked' in attrib:
                del attrib['checked']


HtmlElementClassLookup._default_element_classes['input'] = InputElement


class LabelElement(HtmlElement):
    """
    Represents a ``<label>`` element.

    Label elements are linked to other elements with their ``for``
    attribute.  You can access this element with ``label.for_element``.
    """
    @property
    def for_element(self):
        """
        Get/set the element this label points to.  Return None if it
        can't be found.
        """
        id = self.get('for')
        if not id:
            return None
        return self.body.get_element_by_id(id)

    @for_element.setter
    def for_element(self, other):
        id = other.get('id')
        if not id:
            raise TypeError(
                "Element %r has no id attribute" % other)
        self.set('for', id)

    @for_element.deleter
    def for_element(self):
        attrib = self.attrib
        if 'id' in attrib:
            del attrib['id']


HtmlElementClassLookup._default_element_classes['label'] = LabelElement


############################################################
## Serialization
############################################################

def html_to_xhtml(html):
    """Convert all tags in an HTML tree to XHTML by moving them to the
    XHTML namespace.
    """
    try:
        html = html.getroot()
    except AttributeError:
        pass
    prefix = "{%s}" % XHTML_NAMESPACE
    for el in html.iter(etree.Element):
        tag = el.tag
        if tag[0] != '{':
            el.tag = prefix + tag


def xhtml_to_html(xhtml):
    """Convert all tags in an XHTML tree to HTML by removing their
    XHTML namespace.
    """
    try:
        xhtml = xhtml.getroot()
    except AttributeError:
        pass
    prefix = "{%s}" % XHTML_NAMESPACE
    prefix_len = len(prefix)
    for el in xhtml.iter(prefix + "*"):
        el.tag = el.tag[prefix_len:]


# This isn't a general match, but it's a match for what libxml2
# specifically serialises:
__str_replace_meta_content_type = re.compile(
    r'<meta http-equiv="Content-Type"[^>]*>').sub
__bytes_replace_meta_content_type = re.compile(
    br'<meta http-equiv="Content-Type"[^>]*>').sub


def tostring(doc, pretty_print=False, include_meta_content_type=False,
             encoding=None, method="html", with_tail=True, doctype=None):
    """Return an HTML string representation of the document.

    Note: if include_meta_content_type is true this will create a
    ``<meta http-equiv="Content-Type" ...>`` tag in the head;
    regardless of the value of include_meta_content_type any existing
    ``<meta http-equiv="Content-Type" ...>`` tag will be removed

    The ``encoding`` argument controls the output encoding (defaults to
    ASCII, with &#...; character references for any characters outside
    of ASCII).  Note that you can pass the name ``'unicode'`` as
    ``encoding`` argument to serialise to a Unicode string.

    The ``method`` argument defines the output method.  It defaults to
    'html', but can also be 'xml' for xhtml output, or 'text' to
    serialise to plain text without markup.

    To leave out the tail text of the top-level element that is being
    serialised, pass ``with_tail=False``.

    The ``doctype`` option allows passing in a plain string that will
    be serialised before the XML tree.  Note that passing in non
    well-formed content here will make the XML output non well-formed.
    Also, an existing doctype in the document tree will not be removed
    when serialising an ElementTree instance.

    Example::

        >>> from lxml import html
        >>> root = html.fragment_fromstring('<p>Hello<br>world!</p>')

        >>> html.tostring(root)
        b'<p>Hello<br>world!</p>'
        >>> html.tostring(root, method='html')
        b'<p>Hello<br>world!</p>'

        >>> html.tostring(root, method='xml')
        b'<p>Hello<br/>world!</p>'

        >>> html.tostring(root, method='text')
        b'Helloworld!'

        >>> html.tostring(root, method='text', encoding='unicode')
        u'Helloworld!'

        >>> root = html.fragment_fromstring('<div><p>Hello<br>world!</p>TAIL</div>')
        >>> html.tostring(root[0], method='text', encoding='unicode')
        u'Helloworld!TAIL'

        >>> html.tostring(root[0], method='text', encoding='unicode', with_tail=False)
        u'Helloworld!'

        >>> doc = html.document_fromstring('<p>Hello<br>world!</p>')
        >>> html.tostring(doc, method='html', encoding='unicode')
        u'<html><body><p>Hello<br>world!</p></body></html>'

        >>> print(html.tostring(doc, method='html', encoding='unicode',
        ...          doctype='<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"'
        ...                  ' "http://www.w3.org/TR/html4/strict.dtd">'))
        <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">
        <html><body><p>Hello<br>world!</p></body></html>
    """
    html = etree.tostring(doc, method=method, pretty_print=pretty_print,
                          encoding=encoding, with_tail=with_tail,
                          doctype=doctype)
    if method == 'html' and not include_meta_content_type:
        if isinstance(html, str):
            html = __str_replace_meta_content_type('', html)
        else:
            html = __bytes_replace_meta_content_type(b'', html)
    return html


tostring.__doc__ = __fix_docstring(tostring.__doc__)


def open_in_browser(doc, encoding=None):
    """
    Open the HTML document in a web browser, saving it to a temporary
    file to open it.  Note that this does not delete the file after
    use.  This is mainly meant for debugging.
    """
    import os
    import webbrowser
    import tempfile
    if not isinstance(doc, etree._ElementTree):
        doc = etree.ElementTree(doc)
    handle, fn = tempfile.mkstemp(suffix='.html')
    f = os.fdopen(handle, 'wb')
    try:
        doc.write(f, method="html", encoding=encoding or doc.docinfo.encoding or "UTF-8")
    finally:
        # we leak the file itself here, but we should at least close it
        f.close()
    url = 'file://' + fn.replace(os.path.sep, '/')
    print(url)
    webbrowser.open(url)


################################################################################
# configure Element class lookup
################################################################################

class HTMLParser(etree.HTMLParser):
    """An HTML parser that is configured to return lxml.html Element
    objects.
    """
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.set_element_class_lookup(HtmlElementClassLookup())


class XHTMLParser(etree.XMLParser):
    """An XML parser that is configured to return lxml.html Element
    objects.

    Note that this parser is not really XHTML aware unless you let it
    load a DTD that declares the HTML entities.  To do this, make sure
    you have the XHTML DTDs installed in your catalogs, and create the
    parser like this::

        >>> parser = XHTMLParser(load_dtd=True)

    If you additionally want to validate the document, use this::

        >>> parser = XHTMLParser(dtd_validation=True)

    For catalog support, see http://www.xmlsoft.org/catalog.html.
    """
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.set_element_class_lookup(HtmlElementClassLookup())


def Element(*args, **kw):
    """Create a new HTML Element.

    This can also be used for XHTML documents.
    """
    v = html_parser.makeelement(*args, **kw)
    return v


html_parser = HTMLParser()
xhtml_parser = XHTMLParser()
