# cython: language_level=3

try:
    import cython
except ImportError:
    class fake_cython:
        compiled = False
        def cfunc(self, func): return func
        def cclass(self, func): return func
        def declare(self, _, value): return value
        def __getattr__(self, type_name): return "object"

    cython = fake_cython()

try:
    from . import _difflib as difflib
    import inspect
    if inspect.isfunction(difflib.get_close_matches):
        raise ImportError(
            "Embedded difflib is not compiled to a fast binary, using the stdlib instead.")
    from cython.cimports.lxml.html._difflib import SequenceMatcher
except ImportError:
    import difflib
    if not cython.compiled:
        from difflib import SequenceMatcher

import itertools
import functools
import operator
import re

from lxml import etree
from lxml.html import fragment_fromstring
from . import defs

__all__ = ['html_annotate', 'htmldiff']

group_by_first_item = functools.partial(itertools.groupby, key=operator.itemgetter(0))


############################################################
## Annotation
############################################################

@cython.cfunc
def html_escape(text: str, _escapes: tuple = ('&amp;', '&lt;', '&gt;', '&quot;', '&#x27;')) -> str:
    # Not so slow compiled version of 'html.escape()'.
    # Most of the time, we replace little to nothing, so use a fast decision what needs to be done.
    ch: cython.Py_UCS4
    replace: cython.char[5] = [False] * 5
    for ch in text:
        replace[0] |= ch == '&'
        replace[1] |= ch == '<'
        replace[2] |= ch == '>'
        replace[3] |= ch == '"'
        replace[4] |= ch == "'"

    for i in range(5):
        if replace[i]:
            text = text.replace('&<>"\''[i], _escapes[i])

    return text


if not cython.compiled:
    from html import escape as html_escape


def default_markup(text, version):
    return '<span title="%s">%s</span>' % (
        html_escape(version), text)

def html_annotate(doclist, markup=default_markup):
    """
    doclist should be ordered from oldest to newest, like::

        >>> version1 = 'Hello World'
        >>> version2 = 'Goodbye World'
        >>> print(html_annotate([(version1, 'version 1'),
        ...                      (version2, 'version 2')]))
        <span title="version 2">Goodbye</span> <span title="version 1">World</span>

    The documents must be *fragments* (str/UTF8 or unicode), not
    complete documents

    The markup argument is a function to markup the spans of words.
    This function is called like markup('Hello', 'version 2'), and
    returns HTML.  The first argument is text and never includes any
    markup.  The default uses a span with a title:

        >>> print(default_markup('Some Text', 'by Joe'))
        <span title="by Joe">Some Text</span>
    """
    # The basic strategy we have is to split the documents up into
    # logical tokens (which are words with attached markup).  We then
    # do diffs of each of the versions to track when a token first
    # appeared in the document; the annotation attached to the token
    # is the version where it first appeared.
    tokenlist = [tokenize_annotated(doc, version)
                 for doc, version in doclist]
    cur_tokens = tokenlist[0]
    for tokens in tokenlist[1:]:
        html_annotate_merge_annotations(cur_tokens, tokens)
        cur_tokens = tokens

    # After we've tracked all the tokens, we can combine spans of text
    # that are adjacent and have the same annotation
    cur_tokens = compress_tokens(cur_tokens)
    # And finally add markup
    result = markup_serialize_tokens(cur_tokens, markup)
    return ''.join(result).strip()

def tokenize_annotated(doc, annotation):
    """Tokenize a document and add an annotation attribute to each token
    """
    tokens = tokenize(doc, include_hrefs=False)
    for tok in tokens:
        tok.annotation = annotation
    return tokens

def html_annotate_merge_annotations(tokens_old, tokens_new):
    """Merge the annotations from tokens_old into tokens_new, when the
    tokens in the new document already existed in the old document.
    """
    s = InsensitiveSequenceMatcher(a=tokens_old, b=tokens_new)
    commands = s.get_opcodes()

    for command, i1, i2, j1, j2 in commands:
        if command == 'equal':
            eq_old = tokens_old[i1:i2]
            eq_new = tokens_new[j1:j2]
            copy_annotations(eq_old, eq_new)

def copy_annotations(src, dest):
    """
    Copy annotations from the tokens listed in src to the tokens in dest
    """
    assert len(src) == len(dest)
    for src_tok, dest_tok in zip(src, dest):
        dest_tok.annotation = src_tok.annotation

def compress_tokens(tokens):
    """
    Combine adjacent tokens when there is no HTML between the tokens,
    and they share an annotation
    """
    result = [tokens[0]]
    for tok in tokens[1:]:
        if (not tok.pre_tags and
                not result[-1].post_tags and
                result[-1].annotation == tok.annotation):
            compress_merge_back(result, tok)
        else:
            result.append(tok)
    return result

@cython.cfunc
def compress_merge_back(tokens: list, tok):
    """ Merge tok into the last element of tokens (modifying the list of
    tokens in-place).  """
    last = tokens[-1]
    if type(last) is not token or type(tok) is not token:
        tokens.append(tok)
    else:
        text = last + last.trailing_whitespace + tok
        merged = token(text,
                       pre_tags=last.pre_tags,
                       post_tags=tok.post_tags,
                       trailing_whitespace=tok.trailing_whitespace)
        merged.annotation = last.annotation
        tokens[-1] = merged

def markup_serialize_tokens(tokens, markup_func):
    """
    Serialize the list of tokens into a list of text chunks, calling
    markup_func around text to add annotations.
    """
    for token in tokens:
        yield from token.pre_tags
        html = token.html()
        html = markup_func(html, token.annotation) + token.trailing_whitespace
        yield html
        yield from token.post_tags


############################################################
## HTML Diffs
############################################################

def htmldiff(old_html, new_html):
    ## FIXME: this should take parsed documents too, and use their body
    ## or other content.
    """ Do a diff of the old and new document.  The documents are HTML
    *fragments* (str/UTF8 or unicode), they are not complete documents
    (i.e., no <html> tag).

    Returns HTML with <ins> and <del> tags added around the
    appropriate text.

    Markup is generally ignored, with the markup from new_html
    preserved, and possibly some markup from old_html (though it is
    considered acceptable to lose some of the old markup).  Only the
    words in the HTML are diffed.  The exception is <img> tags, which
    are treated like words, and the href attribute of <a> tags, which
    are noted inside the tag itself when there are changes.
    """
    old_html_tokens = tokenize(old_html)
    new_html_tokens = tokenize(new_html)
    result = htmldiff_tokens(old_html_tokens, new_html_tokens)
    try:
        result = ''.join(result).strip()
    except (ValueError, TypeError) as exc:
        print(exc)
        result = ''
    return fixup_ins_del_tags(result)


def htmldiff_tokens(html1_tokens, html2_tokens):
    """ Does a diff on the tokens themselves, returning a list of text
    chunks (not tokens).
    """
    # There are several passes as we do the differences.  The tokens
    # isolate the portion of the content we care to diff; difflib does
    # all the actual hard work at that point.
    #
    # Then we must create a valid document from pieces of both the old
    # document and the new document.  We generally prefer to take
    # markup from the new document, and only do a best effort attempt
    # to keep markup from the old document; anything that we can't
    # resolve we throw away.  Also we try to put the deletes as close
    # to the location where we think they would have been -- because
    # we are only keeping the markup from the new document, it can be
    # fuzzy where in the new document the old text would have gone.
    # Again we just do a best effort attempt.
    s = InsensitiveSequenceMatcher(a=html1_tokens, b=html2_tokens)
    commands = s.get_opcodes()
    result = []
    for command, i1, i2, j1, j2 in commands:
        if command == 'equal':
            result.extend(expand_tokens(html2_tokens[j1:j2], equal=True))
            continue
        if command == 'insert' or command == 'replace':
            ins_tokens = expand_tokens(html2_tokens[j1:j2])
            merge_insert(ins_tokens, result)
        if command == 'delete' or command == 'replace':
            del_tokens = expand_tokens(html1_tokens[i1:i2])
            merge_delete(del_tokens, result)

    # If deletes were inserted directly as <del> then we'd have an
    # invalid document at this point.  Instead we put in special
    # markers, and when the complete diffed document has been created
    # we try to move the deletes around and resolve any problems.
    cleanup_delete(result)

    return result


def expand_tokens(tokens, equal=False):
    """Given a list of tokens, return a generator of the chunks of
    text for the data in the tokens.
    """
    for token in tokens:
        yield from token.pre_tags
        if not equal or not token.hide_when_equal:
            yield token.html() + token.trailing_whitespace
        yield from token.post_tags


def merge_insert(ins_chunks, doc: list):
    """ doc is the already-handled document (as a list of text chunks);
    here we add <ins>ins_chunks</ins> to the end of that.  """
    # Though we don't throw away unbalanced start/end tags
    # (we assume there is accompanying markup later or earlier in the
    # document), we only put <ins> around the balanced portion.

    # Legacy note: We make a choice here. Originally, we merged all sequences of
    # unbalanced tags together into separate start and end tag groups. Now, we look at
    # each sequence separately, leading to more fine-grained diffs but different
    # tag structure than before.

    item: tuple
    for balanced, marked_chunks in group_by_first_item(mark_unbalanced(ins_chunks)):
        chunks = [item[1] for item in marked_chunks]
        if balanced == 'b':
            if doc and not doc[-1].endswith(' '):
                # Fix up the case where the word before the insert didn't end with a space.
                doc[-1] += ' '
            doc.append('<ins>')
            doc.extend(chunks)
            if doc[-1].endswith(' '):
                # We move space outside of </ins>.
                doc[-1] = doc[-1][:-1]
            doc.append('</ins> ')
        else:
            # unmatched start or end
            doc.extend(chunks)


@cython.cfunc
def tag_name_of_chunk(chunk: str) -> str:
    i: cython.Py_ssize_t
    ch: cython.Py_UCS4

    if chunk[0] != '<':
        return ""

    start_pos = 1
    for i, ch in enumerate(chunk):
        if ch == '/':
            start_pos = 2
        elif ch == '>':
            return chunk[start_pos:i]
        elif ch.isspace():
            return chunk[start_pos:i]

    return chunk[start_pos:]

if not cython.compiled:
    # Avoid performance regression in Python due to string iteration.
    def tag_name_of_chunk(chunk: str) -> str:
        return chunk.split(None, 1)[0].strip('<>/')


# These are sentinels to represent the start and end of a <del>
# segment, until we do the cleanup phase to turn them into proper
# markup:
class DEL_START:
    pass
class DEL_END:
    pass


def merge_delete(del_chunks, doc: list):
    """ Adds the text chunks in del_chunks to the document doc (another
    list of text chunks) with marker to show it is a delete.
    cleanup_delete later resolves these markers into <del> tags."""

    doc.append(DEL_START)
    doc.extend(del_chunks)
    doc.append(DEL_END)


def cleanup_delete(chunks: list):
    """ Cleans up any DEL_START/DEL_END markers in the document, replacing
    them with <del></del>.  To do this while keeping the document
    valid, it may need to drop some tags (either start or end tags).

    It may also move the del into adjacent tags to try to move it to a
    similar location where it was originally located (e.g., moving a
    delete into preceding <div> tag, if the del looks like (DEL_START,
    'Text</div>', DEL_END)
    """
    chunk_count = len(chunks)

    i: cython.Py_ssize_t
    del_start: cython.Py_ssize_t
    del_end: cython.Py_ssize_t
    shift_start_right: cython.Py_ssize_t
    shift_end_left: cython.Py_ssize_t
    unbalanced_start: cython.Py_ssize_t
    unbalanced_end: cython.Py_ssize_t
    pos: cython.Py_ssize_t
    start_pos: cython.Py_ssize_t
    chunk: str

    start_pos = 0
    while 1:
        # Find a pending DEL_START/DEL_END, splitting the document
        # into stuff-preceding-DEL_START, stuff-inside, and
        # stuff-following-DEL_END
        try:
            del_start = chunks.index(DEL_START, start_pos)
        except ValueError:
            # Nothing found, we've cleaned up the entire doc
            break
        else:
            del_end = chunks.index(DEL_END, del_start + 1)

        shift_end_left = shift_start_right = 0
        unbalanced_start = unbalanced_end = 0
        deleted_chunks = mark_unbalanced(chunks[del_start+1:del_end])

        # For unbalanced start tags at the beginning, find matching (non-deleted)
        # end tags after the current DEL_END and move the start tag outside.
        for balanced, del_chunk in deleted_chunks:
            if balanced != 'us':
                break
            unbalanced_start += 1
            unbalanced_start_name = tag_name_of_chunk(del_chunk)
            for i in range(del_end+1, chunk_count):
                if chunks[i] is DEL_START:
                    break
                chunk = chunks[i]
                if chunk[0] != '<' or chunk[1] == '/':
                    # Reached a word or closing tag.
                    break
                name = tag_name_of_chunk(chunk)
                if name == 'ins':
                    # Cannot move into an insert.
                    break
                assert name != 'del', f"Unexpected delete tag: {chunk!r}"
                if name != unbalanced_start_name:
                    # Avoid mixing in other start tags.
                    break
                # Exclude start tag to balance the end tag.
                shift_start_right += 1

        # For unbalanced end tags at the end, find matching (non-deleted)
        # start tags before the currend DEL_START and move the end tag outside.
        for balanced, del_chunk in reversed(deleted_chunks):
            if balanced != 'ue':
                break
            unbalanced_end += 1
            unbalanced_end_name = tag_name_of_chunk(del_chunk)
            for i in range(del_start - 1, -1, -1):
                if chunks[i] is DEL_END:
                    break
                chunk = chunks[i]
                if chunk[0] == '<' and chunk[1] != '/':
                    # Reached an opening tag, can we go further?  Maybe not...
                    break
                name = tag_name_of_chunk(chunk)
                if name == 'ins' or name == 'del':
                    # Cannot move into an insert or delete.
                    break
                if name != unbalanced_end_name:
                    # Avoid mixing in other start tags.
                    break
                # Exclude end tag to balance the start tag.
                shift_end_left += 1

        """
        # This is what we do below in loops, spelled out using slicing and list copying:

        chunks[del_start - shift_end_left : del_end + shift_start_right + 1] = [
            *chunks[del_start + 1: del_start + shift_start_right + 1],
            '<del>',
            *chunks[del_start + unbalanced_start + 1 : del_end - unbalanced_end],
            '</del> ',
            *chunks[del_end - shift_end_left: del_end],
        ]

        new_del_end = del_end - 2 * shift_end_left
        assert chunks[new_del_end] == '</del> '
        del_end = new_del_end

        if new_del_start > 0 and not chunks[new_del_start - 1].endswith(' '):
            # Fix up case where the word before us didn't have a trailing space.
            chunks[new_del_start - 1] += ' '
        if new_del_end > 0 and chunks[new_del_end - 1].endswith(' '):
            # Move space outside of </del>.
            chunks[new_del_end - 1] = chunks[new_del_end - 1][:-1]
        """
        pos = del_start - shift_end_left
        # Move re-balanced start tags before the '<del>'.
        for i in range(del_start + 1, del_start + shift_start_right + 1):
            chunks[pos] = chunks[i]
            pos += 1
        if pos and not chunks[pos - 1].endswith(' '):
            # Fix up the case where the word before '<del>' didn't have a trailing space.
            chunks[pos - 1] += ' '
        chunks[pos] = '<del>'
        pos += 1
        # Copy only the balanced deleted content between '<del>' and '</del>'.
        for i in range(del_start + unbalanced_start + 1, del_end - unbalanced_end):
            chunks[pos] = chunks[i]
            pos += 1
        if chunks[pos - 1].endswith(' '):
            # Move trailing space outside of </del>.
            chunks[pos - 1] = chunks[pos - 1][:-1]
        chunks[pos] = '</del> '
        pos += 1
        # Move re-balanced end tags after the '</del>'.
        for i in range(del_end - shift_end_left, del_end):
            chunks[pos] = chunks[i]
            pos += 1
        # Adjust the length of the processed part in 'chunks'.
        del chunks[pos : del_end + shift_start_right + 1]
        start_pos = pos


@cython.cfunc
def mark_unbalanced(chunks) -> list:
    tag_stack = []
    marked = []

    chunk: str
    parents: list

    for chunk in chunks:
        if not chunk.startswith('<'):
            marked.append(('b', chunk))
            continue

        name = tag_name_of_chunk(chunk)
        if name in empty_tags:
            marked.append(('b', chunk))
            continue

        if chunk[1] == '/':
            # closing tag found, unwind tag stack
            while tag_stack:
                start_name, start_chunk, parents = tag_stack.pop()
                if start_name == name:
                    # balanced tag closing, keep rest of stack intact
                    parents.append(('b', start_chunk))
                    parents.extend(marked)
                    parents.append(('b', chunk))
                    marked = parents
                    chunk = None
                    break
                else:
                    # unmatched start tag
                    parents.append(('us', start_chunk))
                    parents.extend(marked)
                    marked = parents

            if chunk is not None:
                # unmatched end tag left after clearing the stack
                marked.append(('ue', chunk))
        else:
            # new start tag found
            tag_stack.append((name, chunk, marked))
            marked = []

    # add any unbalanced start tags
    while tag_stack:
        _, start_chunk, parents = tag_stack.pop()
        parents.append(('us', start_chunk))
        parents.extend(marked)
        marked = parents

    return marked


class token(str):
    """ Represents a diffable token, generally a word that is displayed to
    the user.  Opening tags are attached to this token when they are
    adjacent (pre_tags) and closing tags that follow the word
    (post_tags).  Some exceptions occur when there are empty tags
    adjacent to a word, so there may be close tags in pre_tags, or
    open tags in post_tags.

    We also keep track of whether the word was originally followed by
    whitespace, even though we do not want to treat the word as
    equivalent to a similar word that does not have a trailing
    space."""

    # When this is true, the token will be eliminated from the
    # displayed diff if no change has occurred:
    hide_when_equal = False

    def __new__(cls, text, pre_tags=None, post_tags=None, trailing_whitespace=""):
        obj = str.__new__(cls, text)

        obj.pre_tags = pre_tags if pre_tags is not None else []
        obj.post_tags = post_tags if post_tags is not None else []
        obj.trailing_whitespace = trailing_whitespace

        return obj

    def __repr__(self):
        return 'token(%s, %r, %r, %r)' % (
            str.__repr__(self), self.pre_tags, self.post_tags, self.trailing_whitespace)

    def html(self):
        return str(self)

class tag_token(token):

    """ Represents a token that is actually a tag.  Currently this is just
    the <img> tag, which takes up visible space just like a word but
    is only represented in a document by a tag.  """

    def __new__(cls, tag, data, html_repr, pre_tags=None,
                post_tags=None, trailing_whitespace=""):
        obj = token.__new__(cls, f"{type}: {data}",
                            pre_tags=pre_tags,
                            post_tags=post_tags,
                            trailing_whitespace=trailing_whitespace)
        obj.tag = tag
        obj.data = data
        obj.html_repr = html_repr
        return obj

    def __repr__(self):
        return 'tag_token(%s, %s, html_repr=%s, post_tags=%r, pre_tags=%r, trailing_whitespace=%r)' % (
            self.tag,
            self.data,
            self.html_repr,
            self.pre_tags,
            self.post_tags,
            self.trailing_whitespace)
    def html(self):
        return self.html_repr

class href_token(token):

    """ Represents the href in an anchor tag.  Unlike other words, we only
    show the href when it changes.  """

    hide_when_equal = True

    def html(self):
        return ' Link: %s' % self


def tokenize(html, include_hrefs=True):
    """
    Parse the given HTML and returns token objects (words with attached tags).

    This parses only the content of a page; anything in the head is
    ignored, and the <head> and <body> elements are themselves
    optional.  The content is then parsed by lxml, which ensures the
    validity of the resulting parsed document (though lxml may make
    incorrect guesses when the markup is particular bad).

    <ins> and <del> tags are also eliminated from the document, as
    that gets confusing.

    If include_hrefs is true, then the href attribute of <a> tags is
    included as a special kind of diffable token."""
    if etree.iselement(html):
        body_el = html
    else:
        body_el = parse_html(html, cleanup=True)
    # Then we split the document into text chunks for each tag, word, and end tag:
    chunks = flatten_el(body_el, skip_tag=True, include_hrefs=include_hrefs)
    # Finally re-joining them into token objects:
    return fixup_chunks(chunks)


def parse_html(html, cleanup=True):
    """
    Parses an HTML fragment, returning an lxml element.  Note that the HTML will be
    wrapped in a <div> tag that was not in the original document.

    If cleanup is true, make sure there's no <head> or <body>, and get
    rid of any <ins> and <del> tags.
    """
    if cleanup:
        # This removes any extra markup or structure like <head>:
        html = cleanup_html(html)
    return fragment_fromstring(html, create_parent=True)


_search_body = re.compile(r'<body.*?>', re.I|re.S).search
_search_end_body = re.compile(r'</body.*?>', re.I|re.S).search
_replace_ins_del = re.compile(r'</?(ins|del).*?>', re.I|re.S).sub

def cleanup_html(html):
    """ This 'cleans' the HTML, meaning that any page structure is removed
    (only the contents of <body> are used, if there is any <body).
    Also <ins> and <del> tags are removed.  """
    match = _search_body(html)
    if match:
        html = html[match.end():]
    match = _search_end_body(html)
    if match:
        html = html[:match.start()]
    html = _replace_ins_del('', html)
    return html


def split_trailing_whitespace(word):
    """
    This function takes a word, such as 'test\n\n' and returns ('test','\n\n')
    """
    stripped_length = len(word.rstrip())
    return word[0:stripped_length], word[stripped_length:]


def fixup_chunks(chunks):
    """
    This function takes a list of chunks and produces a list of tokens.
    """
    tag_accum = []
    cur_word = None
    result = []
    for chunk in chunks:
        if isinstance(chunk, tuple):
            if chunk[0] == 'img':
                src = chunk[1]
                tag, trailing_whitespace = split_trailing_whitespace(chunk[2])
                cur_word = tag_token('img', src, html_repr=tag,
                                     pre_tags=tag_accum,
                                     trailing_whitespace=trailing_whitespace)
                tag_accum = []
                result.append(cur_word)

            elif chunk[0] == 'href':
                href = chunk[1]
                cur_word = href_token(href, pre_tags=tag_accum, trailing_whitespace=" ")
                tag_accum = []
                result.append(cur_word)
            continue

        if is_word(chunk):
            chunk, trailing_whitespace = split_trailing_whitespace(chunk)
            cur_word = token(chunk, pre_tags=tag_accum, trailing_whitespace=trailing_whitespace)
            tag_accum = []
            result.append(cur_word)

        elif is_start_tag(chunk):
            tag_accum.append(chunk)

        elif is_end_tag(chunk):
            if tag_accum:
                tag_accum.append(chunk)
            else:
                assert cur_word, (
                    "Weird state, cur_word=%r, result=%r, chunks=%r of %r"
                    % (cur_word, result, chunk, chunks))
                cur_word.post_tags.append(chunk)
        else:
            assert False

    if not result:
        return [token('', pre_tags=tag_accum)]
    else:
        result[-1].post_tags.extend(tag_accum)

    return result


# All the tags in HTML that don't require end tags:
empty_tags = cython.declare(frozenset, defs.empty_tags)

block_level_tags = cython.declare(frozenset, frozenset([
    'address',
    'blockquote',
    'center',
    'dir',
    'div',
    'dl',
    'fieldset',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'isindex',
    'menu',
    'noframes',
    'noscript',
    'ol',
    'p',
    'pre',
    'table',
    'ul',
]))

block_level_container_tags = cython.declare(frozenset, frozenset([
    'dd',
    'dt',
    'frameset',
    'li',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
]))

any_block_level_tag = cython.declare(tuple, tuple(sorted(
    block_level_tags | block_level_container_tags))
)


def flatten_el(el, include_hrefs, skip_tag=False):
    """ Takes an lxml element el, and generates all the text chunks for
    that tag.  Each start tag is a chunk, each word is a chunk, and each
    end tag is a chunk.

    If skip_tag is true, then the outermost container tag is
    not returned (just its contents)."""
    if not skip_tag:
        if el.tag == 'img':
            yield ('img', el.get('src'), start_tag(el))
        else:
            yield start_tag(el)
    if el.tag in empty_tags and not el.text and not len(el) and not el.tail:
        return
    start_words = split_words(el.text)
    for word in start_words:
        yield html_escape(word)
    for child in el:
        yield from flatten_el(child, include_hrefs=include_hrefs)
    if el.tag == 'a' and el.get('href') and include_hrefs:
        yield ('href', el.get('href'))
    if not skip_tag:
        yield end_tag(el)
        end_words = split_words(el.tail)
        for word in end_words:
            yield html_escape(word)

_find_words = re.compile(r'\S+(?:\s+|$)', re.U).findall

def split_words(text):
    """ Splits some text into words. Includes trailing whitespace
    on each word when appropriate.  """
    if not text or not text.strip():
        return []

    words = _find_words(text)
    return words

_has_start_whitespace = re.compile(r'^[ \t\n\r]').match

def start_tag(el):
    """
    The text representation of the start tag for a tag.
    """
    attributes = ''.join([
        f' {name}="{html_escape(value)}"'
        for name, value in el.attrib.items()
    ])
    return f'<{el.tag}{attributes}>'

def end_tag(el):
    """ The text representation of an end tag for a tag.  Includes
    trailing whitespace when appropriate.  """
    tail = el.tail
    extra = ' ' if tail and _has_start_whitespace(tail) else ''
    return f'</{el.tag}>{extra}'

def is_word(tok):
    return not tok.startswith('<')

def is_end_tag(tok):
    return tok.startswith('</')

def is_start_tag(tok):
    return tok.startswith('<') and not tok.startswith('</')

def fixup_ins_del_tags(html):
    """ Given an html string, move any <ins> or <del> tags inside of any
    block-level elements, e.g. transform <ins><p>word</p></ins> to
    <p><ins>word</ins></p> """
    doc = parse_html(html, cleanup=False)
    _fixup_ins_del_tags(doc)
    html = serialize_html_fragment(doc, skip_outer=True)
    return html

def serialize_html_fragment(el, skip_outer=False):
    """ Serialize a single lxml element as HTML.  The serialized form
    includes the elements tail.

    If skip_outer is true, then don't serialize the outermost tag
    """
    assert not isinstance(el, str), (
        f"You should pass in an element, not a string like {el!r}")
    html = etree.tostring(el, method="html", encoding='unicode')
    if skip_outer:
        # Get rid of the extra starting tag:
        html = html[html.find('>')+1:]
        # Get rid of the extra end tag:
        html = html[:html.rfind('<')]
        return html.strip()
    else:
        return html


@cython.cfunc
def _fixup_ins_del_tags(doc):
    """fixup_ins_del_tags that works on an lxml document in-place
    """
    for el in list(doc.iter('ins', 'del')):
        if not _contains_block_level_tag(el):
            continue
        _move_el_inside_block(el, tag=el.tag)
        el.drop_tag()
        #_merge_element_contents(el)


@cython.cfunc
def _contains_block_level_tag(el):
    """True if the element contains any block-level elements, like <p>, <td>, etc.
    """
    for el in el.iter(*any_block_level_tag):
        return True
    return False


@cython.cfunc
def _move_el_inside_block(el, tag):
    """ helper for _fixup_ins_del_tags; actually takes the <ins> etc tags
    and moves them inside any block-level tags.  """
    makeelement = el.makeelement
    for block_level_el in el.iter(*any_block_level_tag):
        if block_level_el is not el:
            break
    else:
        # No block-level tags in any child
        children_tag = makeelement(tag)
        children_tag.text = el.text
        el.text = None
        children_tag.extend(iter(el))
        el[:] = [children_tag]
        return

    for child in list(el):
        if _contains_block_level_tag(child):
            _move_el_inside_block(child, tag)
            if child.tail:
                tail_tag = makeelement(tag)
                tail_tag.text = child.tail
                child.tail = None
                child.addnext(tail_tag)
        else:
            child_tag = makeelement(tag)
            el.replace(child, child_tag)
            child_tag.append(child)
    if el.text:
        text_tag = makeelement(tag)
        text_tag.text = el.text
        el.text = None
        el.insert(0, text_tag)


def _merge_element_contents(el):
    """
    Removes an element, but merges its contents into its place, e.g.,
    given <p>Hi <i>there!</i></p>, if you remove the <i> element you get
    <p>Hi there!</p>
    """
    parent = el.getparent()
    text = el.text
    tail = el.tail
    if tail:
        if not len(el):
            text = (text or '') + tail
        else:
            el[-1].tail = (el[-1].tail or '') + tail
    index = parent.index(el)
    if text:
        previous = el.getprevious()
        if previous is None:
            parent.text = (parent.text or '') + text
        else:
            previous.tail = (previous.tail or '') + text
    parent[index:index+1] = el.getchildren()


@cython.final
@cython.cclass
class InsensitiveSequenceMatcher(SequenceMatcher):
    """
    Acts like SequenceMatcher, but tries not to find very small equal
    blocks amidst large spans of changes
    """

    threshold = 2

    @cython.cfunc
    def get_matching_blocks(self) -> list:
        size: cython.Py_ssize_t = min(len(self.b), len(self.b))
        threshold: cython.Py_ssize_t = self.threshold
        threshold = min(threshold, size // 4)
        actual = SequenceMatcher.get_matching_blocks(self)
        return [item for item in actual
                if item[2] > threshold
                or not item[2]]


if __name__ == '__main__':
    from lxml.html import _diffcommand
    _diffcommand.main()
