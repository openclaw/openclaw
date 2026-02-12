"""
lxml-based doctest output comparison.

Note: normally, you should just import the `lxml.usedoctest` and
`lxml.html.usedoctest` modules from within a doctest, instead of this
one::

    >>> import lxml.usedoctest # for XML output

    >>> import lxml.html.usedoctest # for HTML output

To use this module directly, you must call ``lxmldoctest.install()``,
which will cause doctest to use this in all subsequent calls.

This changes the way output is checked and comparisons are made for
XML or HTML-like content.

XML or HTML content is noticed because the example starts with ``<``
(it's HTML if it starts with ``<html``).  You can also use the
``PARSE_HTML`` and ``PARSE_XML`` flags to force parsing.

Some rough wildcard-like things are allowed.  Whitespace is generally
ignored (except in attributes).  In text (attributes and text in the
body) you can use ``...`` as a wildcard.  In an example it also
matches any trailing tags in the element, though it does not match
leading tags.  You may create a tag ``<any>`` or include an ``any``
attribute in the tag.  An ``any`` tag matches any tag, while the
attribute matches any and all attributes.

When a match fails, the reformatted example and gotten text is
displayed (indented), and a rough diff-like output is given.  Anything
marked with ``+`` is in the output but wasn't supposed to be, and
similarly ``-`` means its in the example but wasn't in the output.

You can disable parsing on one line with ``# doctest:+NOPARSE_MARKUP``
"""

from lxml import etree
import sys
import re
import doctest
try:
    from html import escape as html_escape
except ImportError:
    from cgi import escape as html_escape

__all__ = ['PARSE_HTML', 'PARSE_XML', 'NOPARSE_MARKUP', 'LXMLOutputChecker',
           'LHTMLOutputChecker', 'install', 'temp_install']

PARSE_HTML = doctest.register_optionflag('PARSE_HTML')
PARSE_XML = doctest.register_optionflag('PARSE_XML')
NOPARSE_MARKUP = doctest.register_optionflag('NOPARSE_MARKUP')

OutputChecker = doctest.OutputChecker

def strip(v):
    if v is None:
        return None
    else:
        return v.strip()

def norm_whitespace(v):
    return _norm_whitespace_re.sub(' ', v)

_html_parser = etree.HTMLParser(recover=False, remove_blank_text=True)

def html_fromstring(html):
    return etree.fromstring(html, _html_parser)

# We use this to distinguish repr()s from elements:
_repr_re = re.compile(r'^<[^>]+ (at|object) ')
_norm_whitespace_re = re.compile(r'[ \t\n][ \t\n]+')

class LXMLOutputChecker(OutputChecker):

    empty_tags = (
        'param', 'img', 'area', 'br', 'basefont', 'input',
        'base', 'meta', 'link', 'col')

    def get_default_parser(self):
        return etree.XML

    def check_output(self, want, got, optionflags):
        alt_self = getattr(self, '_temp_override_self', None)
        if alt_self is not None:
            super_method = self._temp_call_super_check_output
            self = alt_self
        else:
            super_method = OutputChecker.check_output
        parser = self.get_parser(want, got, optionflags)
        if not parser:
            return super_method(
                self, want, got, optionflags)
        try:
            want_doc = parser(want)
        except etree.XMLSyntaxError:
            return False
        try:
            got_doc = parser(got)
        except etree.XMLSyntaxError:
            return False
        return self.compare_docs(want_doc, got_doc)

    def get_parser(self, want, got, optionflags):
        parser = None
        if NOPARSE_MARKUP & optionflags:
            return None
        if PARSE_HTML & optionflags:
            parser = html_fromstring
        elif PARSE_XML & optionflags:
            parser = etree.XML
        elif (want.strip().lower().startswith('<html')
              and got.strip().startswith('<html')):
            parser = html_fromstring
        elif (self._looks_like_markup(want)
              and self._looks_like_markup(got)):
            parser = self.get_default_parser()
        return parser

    def _looks_like_markup(self, s):
        s = s.strip()
        return (s.startswith('<')
                and not _repr_re.search(s))

    def compare_docs(self, want, got):
        if not self.tag_compare(want.tag, got.tag):
            return False
        if not self.text_compare(want.text, got.text, True):
            return False
        if not self.text_compare(want.tail, got.tail, True):
            return False
        if 'any' not in want.attrib:
            want_keys = sorted(want.attrib.keys())
            got_keys = sorted(got.attrib.keys())
            if want_keys != got_keys:
                return False
            for key in want_keys:
                if not self.text_compare(want.attrib[key], got.attrib[key], False):
                    return False
        if want.text != '...' or len(want):
            want_children = list(want)
            got_children = list(got)
            while want_children or got_children:
                if not want_children or not got_children:
                    return False
                want_first = want_children.pop(0)
                got_first = got_children.pop(0)
                if not self.compare_docs(want_first, got_first):
                    return False
                if not got_children and want_first.tail == '...':
                    break
        return True

    def text_compare(self, want, got, strip):
        want = want or ''
        got = got or ''
        if strip:
            want = norm_whitespace(want).strip()
            got = norm_whitespace(got).strip()
        want = '^%s$' % re.escape(want)
        want = want.replace(r'\.\.\.', '.*')
        if re.search(want, got):
            return True
        else:
            return False

    def tag_compare(self, want, got):
        if want == 'any':
            return True
        if (not isinstance(want, (str, bytes))
                or not isinstance(got, (str, bytes))):
            return want == got
        want = want or ''
        got = got or ''
        if want.startswith('{...}'):
            # Ellipsis on the namespace
            return want.split('}')[-1] == got.split('}')[-1]
        else:
            return want == got

    def output_difference(self, example, got, optionflags):
        want = example.want
        parser = self.get_parser(want, got, optionflags)
        errors = []
        if parser is not None:
            try:
                want_doc = parser(want)
            except etree.XMLSyntaxError:
                e = sys.exc_info()[1]
                errors.append('In example: %s' % e)
            try:
                got_doc = parser(got)
            except etree.XMLSyntaxError:
                e = sys.exc_info()[1]
                errors.append('In actual output: %s' % e)
        if parser is None or errors:
            value = OutputChecker.output_difference(
                self, example, got, optionflags)
            if errors:
                errors.append(value)
                return '\n'.join(errors)
            else:
                return value
        html = parser is html_fromstring
        diff_parts = ['Expected:',
                      self.format_doc(want_doc, html, 2),
                      'Got:',
                      self.format_doc(got_doc, html, 2),
                      'Diff:',
                      self.collect_diff(want_doc, got_doc, html, 2)]
        return '\n'.join(diff_parts)

    def html_empty_tag(self, el, html=True):
        if not html:
            return False
        if el.tag not in self.empty_tags:
            return False
        if el.text or len(el):
            # This shouldn't happen (contents in an empty tag)
            return False
        return True

    def format_doc(self, doc, html, indent, prefix=''):
        parts = []
        if not len(doc):
            # No children...
            parts.append(' '*indent)
            parts.append(prefix)
            parts.append(self.format_tag(doc))
            if not self.html_empty_tag(doc, html):
                if strip(doc.text):
                    parts.append(self.format_text(doc.text))
                parts.append(self.format_end_tag(doc))
            if strip(doc.tail):
                parts.append(self.format_text(doc.tail))
            parts.append('\n')
            return ''.join(parts)
        parts.append(' '*indent)
        parts.append(prefix)
        parts.append(self.format_tag(doc))
        if not self.html_empty_tag(doc, html):
            parts.append('\n')
            if strip(doc.text):
                parts.append(' '*indent)
                parts.append(self.format_text(doc.text))
                parts.append('\n')
            for el in doc:
                parts.append(self.format_doc(el, html, indent+2))
            parts.append(' '*indent)
            parts.append(self.format_end_tag(doc))
            parts.append('\n')
        if strip(doc.tail):
            parts.append(' '*indent)
            parts.append(self.format_text(doc.tail))
            parts.append('\n')
        return ''.join(parts)

    def format_text(self, text, strip=True):
        if text is None:
            return ''
        if strip:
            text = text.strip()
        return html_escape(text, 1)

    def format_tag(self, el):
        attrs = []
        if isinstance(el, etree.CommentBase):
            # FIXME: probably PIs should be handled specially too?
            return '<!--'
        for name, value in sorted(el.attrib.items()):
            attrs.append('%s="%s"' % (name, self.format_text(value, False)))
        if not attrs:
            return '<%s>' % el.tag
        return '<%s %s>' % (el.tag, ' '.join(attrs))
    
    def format_end_tag(self, el):
        if isinstance(el, etree.CommentBase):
            # FIXME: probably PIs should be handled specially too?
            return '-->'
        return '</%s>' % el.tag

    def collect_diff(self, want, got, html, indent):
        parts = []
        if not len(want) and not len(got):
            parts.append(' '*indent)
            parts.append(self.collect_diff_tag(want, got))
            if not self.html_empty_tag(got, html):
                parts.append(self.collect_diff_text(want.text, got.text))
                parts.append(self.collect_diff_end_tag(want, got))
            parts.append(self.collect_diff_text(want.tail, got.tail))
            parts.append('\n')
            return ''.join(parts)
        parts.append(' '*indent)
        parts.append(self.collect_diff_tag(want, got))
        parts.append('\n')
        if strip(want.text) or strip(got.text):
            parts.append(' '*indent)
            parts.append(self.collect_diff_text(want.text, got.text))
            parts.append('\n')
        want_children = list(want)
        got_children = list(got)
        while want_children or got_children:
            if not want_children:
                parts.append(self.format_doc(got_children.pop(0), html, indent+2, '+'))
                continue
            if not got_children:
                parts.append(self.format_doc(want_children.pop(0), html, indent+2, '-'))
                continue
            parts.append(self.collect_diff(
                want_children.pop(0), got_children.pop(0), html, indent+2))
        parts.append(' '*indent)
        parts.append(self.collect_diff_end_tag(want, got))
        parts.append('\n')
        if strip(want.tail) or strip(got.tail):
            parts.append(' '*indent)
            parts.append(self.collect_diff_text(want.tail, got.tail))
            parts.append('\n')
        return ''.join(parts)

    def collect_diff_tag(self, want, got):
        if not self.tag_compare(want.tag, got.tag):
            tag = '%s (got: %s)' % (want.tag, got.tag)
        else:
            tag = got.tag
        attrs = []
        any = want.tag == 'any' or 'any' in want.attrib
        for name, value in sorted(got.attrib.items()):
            if name not in want.attrib and not any:
                attrs.append('+%s="%s"' % (name, self.format_text(value, False)))
            else:
                if name in want.attrib:
                    text = self.collect_diff_text(want.attrib[name], value, False)
                else:
                    text = self.format_text(value, False)
                attrs.append('%s="%s"' % (name, text))
        if not any:
            for name, value in sorted(want.attrib.items()):
                if name in got.attrib:
                    continue
                attrs.append('-%s="%s"' % (name, self.format_text(value, False)))
        if attrs:
            tag = '<%s %s>' % (tag, ' '.join(attrs))
        else:
            tag = '<%s>' % tag
        return tag

    def collect_diff_end_tag(self, want, got):
        if want.tag != got.tag:
            tag = '%s (got: %s)' % (want.tag, got.tag)
        else:
            tag = got.tag
        return '</%s>' % tag

    def collect_diff_text(self, want, got, strip=True):
        if self.text_compare(want, got, strip):
            if not got:
                return ''
            return self.format_text(got, strip)
        text = '%s (got: %s)' % (want, got)
        return self.format_text(text, strip)

class LHTMLOutputChecker(LXMLOutputChecker):
    def get_default_parser(self):
        return html_fromstring
    
def install(html=False):
    """
    Install doctestcompare for all future doctests.

    If html is true, then by default the HTML parser will be used;
    otherwise the XML parser is used.
    """
    if html:
        doctest.OutputChecker = LHTMLOutputChecker
    else:
        doctest.OutputChecker = LXMLOutputChecker

def temp_install(html=False, del_module=None):
    """
    Use this *inside* a doctest to enable this checker for this
    doctest only.

    If html is true, then by default the HTML parser will be used;
    otherwise the XML parser is used.
    """
    if html:
        Checker = LHTMLOutputChecker
    else:
        Checker = LXMLOutputChecker
    frame = _find_doctest_frame()
    dt_self = frame.f_locals['self']
    checker = Checker()
    old_checker = dt_self._checker
    dt_self._checker = checker
    # The unfortunate thing is that there is a local variable 'check'
    # in the function that runs the doctests, that is a bound method
    # into the output checker.  We have to update that.  We can't
    # modify the frame, so we have to modify the object in place.  The
    # only way to do this is to actually change the func_code
    # attribute of the method.  We change it, and then wait for
    # __record_outcome to be run, which signals the end of the __run
    # method, at which point we restore the previous check_output
    # implementation.
    check_func = frame.f_locals['check'].__func__
    checker_check_func = checker.check_output.__func__
    # Because we can't patch up func_globals, this is the only global
    # in check_output that we care about:
    doctest.etree = etree
    _RestoreChecker(dt_self, old_checker, checker,
                    check_func, checker_check_func,
                    del_module)

class _RestoreChecker:
    def __init__(self, dt_self, old_checker, new_checker, check_func, clone_func,
                 del_module):
        self.dt_self = dt_self
        self.checker = old_checker
        self.checker._temp_call_super_check_output = self.call_super
        self.checker._temp_override_self = new_checker
        self.check_func = check_func
        self.clone_func = clone_func
        self.del_module = del_module
        self.install_clone()
        self.install_dt_self()
    def install_clone(self):
        self.func_code = self.check_func.__code__
        self.func_globals = self.check_func.__globals__
        self.check_func.__code__ = self.clone_func.__code__
    def uninstall_clone(self):
        self.check_func.__code__ = self.func_code
    def install_dt_self(self):
        self.prev_func = self.dt_self._DocTestRunner__record_outcome
        self.dt_self._DocTestRunner__record_outcome = self
    def uninstall_dt_self(self):
        self.dt_self._DocTestRunner__record_outcome = self.prev_func
    def uninstall_module(self):
        if self.del_module:
            import sys
            del sys.modules[self.del_module]
            if '.' in self.del_module:
                package, module = self.del_module.rsplit('.', 1)
                package_mod = sys.modules[package]
                delattr(package_mod, module)
    def __call__(self, *args, **kw):
        self.uninstall_clone()
        self.uninstall_dt_self()
        del self.checker._temp_override_self
        del self.checker._temp_call_super_check_output
        result = self.prev_func(*args, **kw)
        self.uninstall_module()
        return result
    def call_super(self, *args, **kw):
        self.uninstall_clone()
        try:
            return self.check_func(*args, **kw)
        finally:
            self.install_clone()
            
def _find_doctest_frame():
    import sys
    frame = sys._getframe(1)
    while frame:
        l = frame.f_locals
        if 'BOOM' in l:
            # Sign of doctest
            return frame
        frame = frame.f_back
    raise LookupError(
        "Could not find doctest (only use this function *inside* a doctest)")
    
__test__ = {
    'basic': '''
    >>> temp_install()
    >>> print """<xml a="1" b="2">stuff</xml>"""
    <xml b="2" a="1">...</xml>
    >>> print """<xml xmlns="http://example.com"><tag   attr="bar"   /></xml>"""
    <xml xmlns="...">
      <tag attr="..." />
    </xml>
    >>> print """<xml>blahblahblah<foo /></xml>""" # doctest: +NOPARSE_MARKUP, +ELLIPSIS
    <xml>...foo /></xml>
    '''}

if __name__ == '__main__':
    import doctest
    doctest.testmod()
    
    
