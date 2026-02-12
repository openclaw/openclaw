# cython: language_level=3

#
# ElementTree
# $Id: ElementPath.py 3375 2008-02-13 08:05:08Z fredrik $
#
# limited xpath support for element trees
#
# history:
# 2003-05-23 fl   created
# 2003-05-28 fl   added support for // etc
# 2003-08-27 fl   fixed parsing of periods in element names
# 2007-09-10 fl   new selection engine
# 2007-09-12 fl   fixed parent selector
# 2007-09-13 fl   added iterfind; changed findall to return a list
# 2007-11-30 fl   added namespaces support
# 2009-10-30 fl   added child element value filter
#
# Copyright (c) 2003-2009 by Fredrik Lundh.  All rights reserved.
#
# fredrik@pythonware.com
# http://www.pythonware.com
#
# --------------------------------------------------------------------
# The ElementTree toolkit is
#
# Copyright (c) 1999-2009 by Fredrik Lundh
#
# By obtaining, using, and/or copying this software and/or its
# associated documentation, you agree that you have read, understood,
# and will comply with the following terms and conditions:
#
# Permission to use, copy, modify, and distribute this software and
# its associated documentation for any purpose and without fee is
# hereby granted, provided that the above copyright notice appears in
# all copies, and that both that copyright notice and this permission
# notice appear in supporting documentation, and that the name of
# Secret Labs AB or the author not be used in advertising or publicity
# pertaining to distribution of the software without specific, written
# prior permission.
#
# SECRET LABS AB AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD
# TO THIS SOFTWARE, INCLUDING ALL IMPLIED WARRANTIES OF MERCHANT-
# ABILITY AND FITNESS.  IN NO EVENT SHALL SECRET LABS AB OR THE AUTHOR
# BE LIABLE FOR ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY
# DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
# WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS
# ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
# OF THIS SOFTWARE.
# --------------------------------------------------------------------

##
# Implementation module for XPath support.  There's usually no reason
# to import this module directly; the <b>ElementTree</b> does this for
# you, if needed.
##


import re

xpath_tokenizer_re = re.compile(
    "("
    "'[^']*'|\"[^\"]*\"|"
    "::|"
    "//?|"
    r"\.\.|"
    r"\(\)|"
    r"[/.*:\[\]\(\)@=])|"
    r"((?:\{[^}]+\})?[^/\[\]\(\)@=\s]+)|"
    r"\s+"
    )

def xpath_tokenizer(pattern, namespaces=None, with_prefixes=True):
    # ElementTree uses '', lxml used None originally.
    default_namespace = (namespaces.get(None) or namespaces.get('')) if namespaces else None
    parsing_attribute = False
    for token in xpath_tokenizer_re.findall(pattern):
        ttype, tag = token
        if tag and tag[0] != "{":
            if ":" in tag and with_prefixes:
                prefix, uri = tag.split(":", 1)
                try:
                    if not namespaces:
                        raise KeyError
                    yield ttype, "{%s}%s" % (namespaces[prefix], uri)
                except KeyError:
                    raise SyntaxError("prefix %r not found in prefix map" % prefix)
            elif tag.isdecimal():
                yield token  # index
            elif default_namespace and not parsing_attribute:
                yield ttype, "{%s}%s" % (default_namespace, tag)
            else:
                yield token
            parsing_attribute = False
        else:
            yield token
            parsing_attribute = ttype == '@'


def prepare_child(next, token):
    tag = token[1]
    def select(result):
        for elem in result:
            yield from elem.iterchildren(tag)
    return select

def prepare_star(next, token):
    def select(result):
        for elem in result:
            yield from elem.iterchildren('*')
    return select

def prepare_self(next, token):
    def select(result):
        return result
    return select

def prepare_descendant(next, token):
    token = next()
    if token[0] == "*":
        tag = "*"
    elif not token[0]:
        tag = token[1]
    else:
        raise SyntaxError("invalid descendant")
    def select(result):
        for elem in result:
            yield from elem.iterdescendants(tag)
    return select

def prepare_parent(next, token):
    def select(result):
        for elem in result:
            parent = elem.getparent()
            if parent is not None:
                yield parent
    return select

def prepare_predicate(next, token):
    # FIXME: replace with real parser!!! refs:
    # http://effbot.org/zone/simple-iterator-parser.htm
    # http://javascript.crockford.com/tdop/tdop.html
    signature = ''
    predicate = []
    while 1:
        token = next()
        if token[0] == "]":
            break
        if token == ('', ''):
            # ignore whitespace
            continue
        if token[0] and token[0][:1] in "'\"":
            token = "'", token[0][1:-1]
        signature += token[0] or "-"
        predicate.append(token[1])

    # use signature to determine predicate type
    if signature == "@-":
        # [@attribute] predicate
        key = predicate[1]
        def select(result):
            for elem in result:
                if elem.get(key) is not None:
                    yield elem
        return select
    if signature == "@-='":
        # [@attribute='value']
        key = predicate[1]
        value = predicate[-1]
        def select(result):
            for elem in result:
                if elem.get(key) == value:
                    yield elem
        return select
    if signature == "-" and not re.match(r"-?\d+$", predicate[0]):
        # [tag]
        tag = predicate[0]
        def select(result):
            for elem in result:
                for _ in elem.iterchildren(tag):
                    yield elem
                    break
        return select
    if signature == ".='" or (signature == "-='" and not re.match(r"-?\d+$", predicate[0])):
        # [.='value'] or [tag='value']
        tag = predicate[0]
        value = predicate[-1]
        if tag:
            def select(result):
                for elem in result:
                    for e in elem.iterchildren(tag):
                        if "".join(e.itertext()) == value:
                            yield elem
                            break
        else:
            def select(result):
                for elem in result:
                    if "".join(elem.itertext()) == value:
                        yield elem
        return select
    if signature == "-" or signature == "-()" or signature == "-()-":
        # [index] or [last()] or [last()-index]
        if signature == "-":
            # [index]
            index = int(predicate[0]) - 1
            if index < 0:
                if index == -1:
                    raise SyntaxError(
                        "indices in path predicates are 1-based, not 0-based")
                else:
                    raise SyntaxError("path index >= 1 expected")
        else:
            if predicate[0] != "last":
                raise SyntaxError("unsupported function")
            if signature == "-()-":
                try:
                    index = int(predicate[2]) - 1
                except ValueError:
                    raise SyntaxError("unsupported expression")
            else:
                index = -1
        def select(result):
            for elem in result:
                parent = elem.getparent()
                if parent is None:
                    continue
                try:
                    # FIXME: what if the selector is "*" ?
                    elems = list(parent.iterchildren(elem.tag))
                    if elems[index] is elem:
                        yield elem
                except IndexError:
                    pass
        return select
    raise SyntaxError("invalid predicate")

ops = {
    "": prepare_child,
    "*": prepare_star,
    ".": prepare_self,
    "..": prepare_parent,
    "//": prepare_descendant,
    "[": prepare_predicate,
}


# --------------------------------------------------------------------

_cache = {}


def _build_path_iterator(path, namespaces, with_prefixes=True):
    """compile selector pattern"""
    if path[-1:] == "/":
        path += "*"  # implicit all (FIXME: keep this?)

    cache_key = (path,)
    if namespaces:
        # lxml originally used None for the default namespace but ElementTree uses the
        # more convenient (all-strings-dict) empty string, so we support both here,
        # preferring the more convenient '', as long as they aren't ambiguous.
        if None in namespaces:
            if '' in namespaces and namespaces[None] != namespaces['']:
                raise ValueError("Ambiguous default namespace provided: %r versus %r" % (
                    namespaces[None], namespaces['']))
            cache_key += (namespaces[None],) + tuple(sorted(
                item for item in namespaces.items() if item[0] is not None))
        else:
            cache_key += tuple(sorted(namespaces.items()))

    try:
        return _cache[cache_key]
    except KeyError:
        pass
    if len(_cache) > 100:
        _cache.clear()

    if path[:1] == "/":
        raise SyntaxError("cannot use absolute path on element")
    stream = iter(xpath_tokenizer(path, namespaces, with_prefixes=with_prefixes))
    try:
        _next = stream.next
    except AttributeError:
        # Python 3
        _next = stream.__next__
    try:
        token = _next()
    except StopIteration:
        raise SyntaxError("empty path expression")
    selector = []
    while 1:
        try:
            selector.append(ops[token[0]](_next, token))
        except StopIteration:
            raise SyntaxError("invalid path")
        try:
            token = _next()
            if token[0] == "/":
                token = _next()
        except StopIteration:
            break
    _cache[cache_key] = selector
    return selector


##
# Iterate over the matching nodes

def iterfind(elem, path, namespaces=None, with_prefixes=True):
    selector = _build_path_iterator(path, namespaces, with_prefixes=with_prefixes)
    result = iter((elem,))
    for select in selector:
        result = select(result)
    return result


##
# Find first matching object.

def find(elem, path, namespaces=None, with_prefixes=True):
    it = iterfind(elem, path, namespaces, with_prefixes=with_prefixes)
    try:
        return next(it)
    except StopIteration:
        return None


##
# Find all matching objects.

def findall(elem, path, namespaces=None, with_prefixes=True):
    return list(iterfind(elem, path, namespaces))


##
# Find text for first matching object.

def findtext(elem, path, default=None, namespaces=None, with_prefixes=True):
    el = find(elem, path, namespaces, with_prefixes=with_prefixes)
    if el is None:
        return default
    else:
        return el.text or ''
