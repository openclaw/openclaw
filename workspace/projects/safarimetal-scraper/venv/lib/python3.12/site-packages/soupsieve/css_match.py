"""CSS matcher."""
from __future__ import annotations
from datetime import datetime
from . import util
import re
from . import css_types as ct
import unicodedata
import bs4
from typing import Iterator, Iterable, Any, Callable, Sequence, Any, cast  # noqa: F401, F811

# Empty tag pattern (whitespace okay)
RE_NOT_EMPTY = re.compile('[^ \t\r\n\f]')

RE_NOT_WS = re.compile('[^ \t\r\n\f]+')

# Relationships
REL_PARENT = ' '
REL_CLOSE_PARENT = '>'
REL_SIBLING = '~'
REL_CLOSE_SIBLING = '+'

# Relationships for :has() (forward looking)
REL_HAS_PARENT = ': '
REL_HAS_CLOSE_PARENT = ':>'
REL_HAS_SIBLING = ':~'
REL_HAS_CLOSE_SIBLING = ':+'

NS_XHTML = 'http://www.w3.org/1999/xhtml'
NS_XML = 'http://www.w3.org/XML/1998/namespace'

DIR_FLAGS = ct.SEL_DIR_LTR | ct.SEL_DIR_RTL
RANGES = ct.SEL_IN_RANGE | ct.SEL_OUT_OF_RANGE

DIR_MAP = {
    'ltr': ct.SEL_DIR_LTR,
    'rtl': ct.SEL_DIR_RTL,
    'auto': 0
}

RE_NUM = re.compile(r"^(?P<value>-?(?:[0-9]{1,}(\.[0-9]+)?|\.[0-9]+))$")
RE_TIME = re.compile(r'^(?P<hour>[0-9]{2}):(?P<minutes>[0-9]{2})$')
RE_MONTH = re.compile(r'^(?P<year>[0-9]{4,})-(?P<month>[0-9]{2})$')
RE_WEEK = re.compile(r'^(?P<year>[0-9]{4,})-W(?P<week>[0-9]{2})$')
RE_DATE = re.compile(r'^(?P<year>[0-9]{4,})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})$')
RE_DATETIME = re.compile(
    r'^(?P<year>[0-9]{4,})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})T(?P<hour>[0-9]{2}):(?P<minutes>[0-9]{2})$'
)
RE_WILD_STRIP = re.compile(r'(?:(?:-\*-)(?:\*(?:-|$))*|-\*$)')

MONTHS_30 = (4, 6, 9, 11)  # April, June, September, and November
FEB = 2
SHORT_MONTH = 30
LONG_MONTH = 31
FEB_MONTH = 28
FEB_LEAP_MONTH = 29
DAYS_IN_WEEK = 7


class _FakeParent:
    """
    Fake parent class.

    When we have a fragment with no `BeautifulSoup` document object,
    we can't evaluate `nth` selectors properly.  Create a temporary
    fake parent so we can traverse the root element as a child.
    """

    def __init__(self, element: bs4.Tag) -> None:
        """Initialize."""

        self.contents = [element]

    def __len__(self) -> int:
        """Length."""

        return len(self.contents)


class _DocumentNav:
    """Navigate a Beautiful Soup document."""

    @classmethod
    def assert_valid_input(cls, tag: Any) -> None:
        """Check if valid input tag or document."""

        # Fail on unexpected types.
        if not cls.is_tag(tag):
            raise TypeError(f"Expected a BeautifulSoup 'Tag', but instead received type {type(tag)}")

    @staticmethod
    def is_doc(obj: bs4.element.PageElement | None) -> bool:
        """Is `BeautifulSoup` object."""
        return isinstance(obj, bs4.BeautifulSoup)

    @staticmethod
    def is_tag(obj: bs4.element.PageElement | None) -> bool:
        """Is tag."""
        return isinstance(obj, bs4.Tag)

    @staticmethod
    def is_declaration(obj: bs4.element.PageElement | None) -> bool:  # pragma: no cover
        """Is declaration."""
        return isinstance(obj, bs4.Declaration)

    @staticmethod
    def is_cdata(obj: bs4.element.PageElement | None) -> bool:
        """Is CDATA."""
        return isinstance(obj, bs4.CData)

    @staticmethod
    def is_processing_instruction(obj: bs4.element.PageElement | None) -> bool:  # pragma: no cover
        """Is processing instruction."""
        return isinstance(obj, bs4.ProcessingInstruction)

    @staticmethod
    def is_navigable_string(obj: bs4.element.PageElement | None) -> bool:
        """Is navigable string."""
        return isinstance(obj, bs4.element.NavigableString)

    @staticmethod
    def is_special_string(obj: bs4.element.PageElement | None) -> bool:
        """Is special string."""
        return isinstance(obj, (bs4.Comment, bs4.Declaration, bs4.CData, bs4.ProcessingInstruction, bs4.Doctype))

    @classmethod
    def is_content_string(cls, obj: bs4.element.PageElement | None) -> bool:
        """Check if node is content string."""

        return cls.is_navigable_string(obj) and not cls.is_special_string(obj)

    @staticmethod
    def create_fake_parent(el: bs4.Tag) -> _FakeParent:
        """Create fake parent for a given element."""

        return _FakeParent(el)

    @staticmethod
    def is_xml_tree(el: bs4.Tag | None) -> bool:
        """Check if element (or document) is from a XML tree."""

        return el is not None and bool(el._is_xml)

    def is_iframe(self, el: bs4.Tag | None) -> bool:
        """Check if element is an `iframe`."""

        if el is None:  # pragma: no cover
            return False

        return bool(
            ((el.name if self.is_xml_tree(el) else util.lower(el.name)) == 'iframe') and
            self.is_html_tag(el)  # type: ignore[attr-defined]
        )

    def is_root(self, el: bs4.Tag) -> bool:
        """
        Return whether element is a root element.

        We check that the element is the root of the tree (which we have already pre-calculated),
        and we check if it is the root element under an `iframe`.
        """

        root = self.root and self.root is el  # type: ignore[attr-defined]
        if not root:
            parent = self.get_parent(el)
            root = parent is not None and self.is_html and self.is_iframe(parent)  # type: ignore[attr-defined]
        return root

    def get_contents(self, el: bs4.Tag | None, no_iframe: bool = False) -> Iterator[bs4.element.PageElement]:
        """Get contents or contents in reverse."""

        if el is not None:
            if not no_iframe or not self.is_iframe(el):
                yield from el.contents

    def get_tag_children(
        self,
        el: bs4.Tag | None,
        start: int | None = None,
        reverse: bool = False,
        no_iframe: bool = False
    ) -> Iterator[bs4.Tag]:
        """Get tag children."""

        return self.get_children(el, start, reverse, True, no_iframe)  # type: ignore[return-value]

    def get_children(
        self,
        el: bs4.Tag | None,
        start: int | None = None,
        reverse: bool = False,
        tags: bool = False,
        no_iframe: bool = False
    ) -> Iterator[bs4.element.PageElement]:
        """Get children."""

        if el is not None and (not no_iframe or not self.is_iframe(el)):
            last = len(el.contents) - 1
            if start is None:
                index = last if reverse else 0
            else:
                index = start
            end = -1 if reverse else last + 1
            incr = -1 if reverse else 1

            if 0 <= index <= last:
                while index != end:
                    node = el.contents[index]
                    index += incr
                    if not tags or self.is_tag(node):
                        yield node

    def get_tag_descendants(
        self,
        el: bs4.Tag | None,
        no_iframe: bool = False
    ) -> Iterator[bs4.Tag]:
        """Specifically get tag descendants."""

        yield from self.get_descendants(el, tags=True, no_iframe=no_iframe)  # type: ignore[misc]

    def get_descendants(
        self,
        el: bs4.Tag | None,
        tags: bool = False,
        no_iframe: bool = False
    ) -> Iterator[bs4.element.PageElement]:
        """Get descendants."""

        if el is not None and (not no_iframe or not self.is_iframe(el)):
            next_good = None
            for child in el.descendants:

                if next_good is not None:
                    if child is not next_good:
                        continue
                    next_good = None

                if isinstance(child, bs4.Tag):
                    if no_iframe and self.is_iframe(child):
                        if child.next_sibling is not None:
                            next_good = child.next_sibling
                        else:
                            last_child = child  # type: bs4.element.PageElement
                            while isinstance(last_child, bs4.Tag) and last_child.contents:
                                last_child = last_child.contents[-1]
                            next_good = last_child.next_element
                        yield child
                        if next_good is None:
                            break
                        # Coverage isn't seeing this even though it's executed
                        continue  # pragma: no cover
                    yield child

                elif not tags:
                    yield child

    def get_parent(self, el: bs4.Tag | None, no_iframe: bool = False) -> bs4.Tag | None:
        """Get parent."""

        parent = el.parent if el is not None else None
        if no_iframe and parent is not None and self.is_iframe(parent):  # pragma: no cover
            parent = None
        return parent

    @staticmethod
    def get_tag_name(el: bs4.Tag | None) -> str | None:
        """Get tag."""

        return el.name if el is not None else None

    @staticmethod
    def get_prefix_name(el: bs4.Tag) -> str | None:
        """Get prefix."""

        return el.prefix

    @staticmethod
    def get_uri(el: bs4.Tag | None) -> str | None:
        """Get namespace `URI`."""

        return el.namespace if el is not None else None

    @classmethod
    def get_next_tag(cls, el: bs4.Tag) -> bs4.Tag | None:
        """Get next sibling tag."""

        return cls.get_next(el, tags=True)  # type: ignore[return-value]

    @classmethod
    def get_next(cls, el: bs4.Tag, tags: bool = False) -> bs4.element.PageElement | None:
        """Get next sibling tag."""

        sibling = el.next_sibling
        while tags and not isinstance(sibling, bs4.Tag) and sibling is not None:
            sibling = sibling.next_sibling

        if tags and not isinstance(sibling, bs4.Tag):
            sibling = None

        return sibling

    @classmethod
    def get_previous_tag(cls, el: bs4.Tag, tags: bool = True) -> bs4.Tag | None:
        """Get previous sibling tag."""

        return cls.get_previous(el, True)  # type: ignore[return-value]

    @classmethod
    def get_previous(cls, el: bs4.Tag, tags: bool = False) -> bs4.element.PageElement | None:
        """Get previous sibling tag."""

        sibling = el.previous_sibling
        while tags and not isinstance(sibling, bs4.Tag) and sibling is not None:
            sibling = sibling.previous_sibling

        if tags and not isinstance(sibling, bs4.Tag):
            sibling = None

        return sibling

    @staticmethod
    def has_html_ns(el: bs4.Tag | None) -> bool:
        """
        Check if element has an HTML namespace.

        This is a bit different than whether a element is treated as having an HTML namespace,
        like we do in the case of `is_html_tag`.
        """

        ns = getattr(el, 'namespace') if el is not None else None  # noqa: B009
        return bool(ns and ns == NS_XHTML)

    @staticmethod
    def split_namespace(el: bs4.Tag | None, attr_name: str) -> tuple[str | None, str | None]:
        """Return namespace and attribute name without the prefix."""

        if el is None:  # pragma: no cover
            return None, None

        return getattr(attr_name, 'namespace', None), getattr(attr_name, 'name', None)

    @classmethod
    def normalize_value(cls, value: Any) -> str | Sequence[str]:
        """Normalize the value to be a string or list of strings."""

        # Treat `None` as empty string.
        if value is None:
            return ''

        # Pass through strings
        if (isinstance(value, str)):
            return value

        # If it's a byte string, convert it to Unicode, treating it as UTF-8.
        if isinstance(value, bytes):
            return value.decode("utf8")

        # BeautifulSoup supports sequences of attribute values, so make sure the children are strings.
        if isinstance(value, Sequence):
            new_value = []
            for v in value:
                if not isinstance(v, (str, bytes)) and isinstance(v, Sequence):
                    # This is most certainly a user error and will crash and burn later.
                    # To keep things working, we'll do what we do with all objects,
                    # And convert them to strings.
                    new_value.append(str(v))
                else:
                    # Convert the child to a string
                    new_value.append(cast(str, cls.normalize_value(v)))
            return new_value

        # Try and make anything else a string
        return str(value)

    @classmethod
    def get_attribute_by_name(
        cls,
        el: bs4.Tag,
        name: str,
        default: str | Sequence[str] | None = None
    ) -> str | Sequence[str] | None:
        """Get attribute by name."""

        value = default
        if el._is_xml:
            try:
                value = cls.normalize_value(el.attrs[name])
            except KeyError:
                pass
        else:
            for k, v in el.attrs.items():
                if util.lower(k) == name:
                    value = cls.normalize_value(v)
                    break
        return value

    @classmethod
    def iter_attributes(cls, el: bs4.Tag | None) -> Iterator[tuple[str, str | Sequence[str] | None]]:
        """Iterate attributes."""

        if el is not None:
            for k, v in el.attrs.items():
                yield k, cls.normalize_value(v)

    @classmethod
    def get_classes(cls, el: bs4.Tag) -> Sequence[str]:
        """Get classes."""

        classes = cls.get_attribute_by_name(el, 'class', [])
        if isinstance(classes, str):
            classes = RE_NOT_WS.findall(classes)
        return cast(Sequence[str], classes)

    def get_text(self, el: bs4.Tag, no_iframe: bool = False) -> str:
        """Get text."""

        return ''.join(
            [
                node for node in self.get_descendants(el, no_iframe=no_iframe)  # type: ignore[misc]
                if self.is_content_string(node)
            ]
        )

    def get_own_text(self, el: bs4.Tag, no_iframe: bool = False) -> list[str]:
        """Get Own Text."""

        return [
            node for node in self.get_contents(el, no_iframe=no_iframe) if self.is_content_string(node)  # type: ignore[misc]
        ]


class Inputs:
    """Class for parsing and validating input items."""

    @staticmethod
    def validate_day(year: int, month: int, day: int) -> bool:
        """Validate day."""

        max_days = LONG_MONTH
        if month == FEB:
            max_days = FEB_LEAP_MONTH if ((year % 4 == 0) and (year % 100 != 0)) or (year % 400 == 0) else FEB_MONTH
        elif month in MONTHS_30:
            max_days = SHORT_MONTH
        return 1 <= day <= max_days

    @staticmethod
    def validate_week(year: int, week: int) -> bool:
        """Validate week."""

        # Validate an ISO week number for `year`.
        #
        # Per ISO 8601 rules, the last ISO week of a year is the week
        # containing Dec 28. Using Dec 28 guarantees we obtain the
        # correct ISO week-number for the final week of `year`, even in
        # years where Dec 31 falls in ISO week 01 of the following year.
        #
        # Example: if Dec 31 is a Thursday the year's last ISO week will
        # be week 53; if Dec 31 is a Monday and that week is counted as
        # week 1 of the next year, Dec 28 still belongs to the final
        # week of the current ISO year and yields the correct max week.
        max_week = datetime(year, 12, 28).isocalendar()[1]
        return 1 <= week <= max_week

    @staticmethod
    def validate_month(month: int) -> bool:
        """Validate month."""

        return 1 <= month <= 12

    @staticmethod
    def validate_year(year: int) -> bool:
        """Validate year."""

        return 1 <= year

    @staticmethod
    def validate_hour(hour: int) -> bool:
        """Validate hour."""

        return 0 <= hour <= 23

    @staticmethod
    def validate_minutes(minutes: int) -> bool:
        """Validate minutes."""

        return 0 <= minutes <= 59

    @classmethod
    def parse_value(cls, itype: str, value: str | None) -> tuple[float, ...] | None:
        """Parse the input value."""

        parsed = None  # type: tuple[float, ...] | None
        if value is None:
            return value
        if itype == "date":
            m = RE_DATE.match(value)
            if m:
                year = int(m.group('year'), 10)
                month = int(m.group('month'), 10)
                day = int(m.group('day'), 10)
                if cls.validate_year(year) and cls.validate_month(month) and cls.validate_day(year, month, day):
                    parsed = (year, month, day)
        elif itype == "month":
            m = RE_MONTH.match(value)
            if m:
                year = int(m.group('year'), 10)
                month = int(m.group('month'), 10)
                if cls.validate_year(year) and cls.validate_month(month):
                    parsed = (year, month)
        elif itype == "week":
            m = RE_WEEK.match(value)
            if m:
                year = int(m.group('year'), 10)
                week = int(m.group('week'), 10)
                if cls.validate_year(year) and cls.validate_week(year, week):
                    parsed = (year, week)
        elif itype == "time":
            m = RE_TIME.match(value)
            if m:
                hour = int(m.group('hour'), 10)
                minutes = int(m.group('minutes'), 10)
                if cls.validate_hour(hour) and cls.validate_minutes(minutes):
                    parsed = (hour, minutes)
        elif itype == "datetime-local":
            m = RE_DATETIME.match(value)
            if m:
                year = int(m.group('year'), 10)
                month = int(m.group('month'), 10)
                day = int(m.group('day'), 10)
                hour = int(m.group('hour'), 10)
                minutes = int(m.group('minutes'), 10)
                if (
                    cls.validate_year(year) and cls.validate_month(month) and cls.validate_day(year, month, day) and
                    cls.validate_hour(hour) and cls.validate_minutes(minutes)
                ):
                    parsed = (year, month, day, hour, minutes)
        elif itype in ("number", "range"):
            m = RE_NUM.match(value)
            if m:
                parsed = (float(m.group('value')),)
        return parsed


class CSSMatch(_DocumentNav):
    """Perform CSS matching."""

    def __init__(
        self,
        selectors: ct.SelectorList,
        scope: bs4.Tag | None,
        namespaces: ct.Namespaces | None,
        flags: int
    ) -> None:
        """Initialize."""

        self.assert_valid_input(scope)
        self.tag = scope
        self.cached_meta_lang = []  # type: list[tuple[str, str]]
        self.cached_default_forms = []  # type: list[tuple[bs4.Tag, bs4.Tag]]
        self.cached_indeterminate_forms = []  # type: list[tuple[bs4.Tag, str, bool]]
        self.selectors = selectors
        self.namespaces = {} if namespaces is None else namespaces  # type: ct.Namespaces | dict[str, str]
        self.flags = flags
        self.iframe_restrict = False

        # Find the root element for the whole tree
        doc = scope
        parent = self.get_parent(doc)
        while parent:
            doc = parent
            parent = self.get_parent(doc)
        root = None  # type: bs4.Tag | None
        if not self.is_doc(doc):
            root = doc
        else:
            for child in self.get_tag_children(doc):
                root = child
                break

        self.root = root
        self.scope = scope if scope is not doc else root
        self.has_html_namespace = self.has_html_ns(root)

        # A document can be both XML and HTML (XHTML)
        self.is_xml = self.is_xml_tree(doc)
        self.is_html = not self.is_xml or self.has_html_namespace

    def supports_namespaces(self) -> bool:
        """Check if namespaces are supported in the HTML type."""

        return self.is_xml or self.has_html_namespace

    def get_tag_ns(self, el: bs4.Tag | None) -> str:
        """Get tag namespace."""

        namespace = ''
        if el is None:  # pragma: no cover
            return namespace

        if self.supports_namespaces():
            ns = self.get_uri(el)
            if ns:
                namespace = ns
        else:
            namespace = NS_XHTML
        return namespace

    def is_html_tag(self, el: bs4.Tag | None) -> bool:
        """Check if tag is in HTML namespace."""

        return self.get_tag_ns(el) == NS_XHTML

    def get_tag(self, el: bs4.Tag | None) -> str | None:
        """Get tag."""

        name = self.get_tag_name(el)
        return util.lower(name) if name is not None and not self.is_xml else name

    def get_prefix(self, el: bs4.Tag) -> str | None:
        """Get prefix."""

        prefix = self.get_prefix_name(el)
        return util.lower(prefix) if prefix is not None and not self.is_xml else prefix

    def find_bidi(self, el: bs4.Tag) -> int | None:
        """Get directionality from element text."""

        for node in self.get_children(el):

            # Analyze child text nodes
            if self.is_tag(node):

                # Avoid analyzing certain elements specified in the specification.
                direction = DIR_MAP.get(util.lower(self.get_attribute_by_name(node, 'dir', '')), None)  # type: ignore[arg-type]
                name = self.get_tag(node)  # type: ignore[arg-type]
                if (
                    (name and name in ('bdi', 'script', 'style', 'textarea', 'iframe')) or
                    not self.is_html_tag(node) or  # type: ignore[arg-type]
                    direction is not None
                ):
                    continue  # pragma: no cover

                # Check directionality of this node's text
                value = self.find_bidi(node)  # type: ignore[arg-type]
                if value is not None:
                    return value

                # Direction could not be determined
                continue  # pragma: no cover

            # Skip `doctype` comments, etc.
            if self.is_special_string(node):
                continue

            # Analyze text nodes for directionality.
            for c in node:  # type: ignore[attr-defined]
                bidi = unicodedata.bidirectional(c)
                if bidi in ('AL', 'R', 'L'):
                    return ct.SEL_DIR_LTR if bidi == 'L' else ct.SEL_DIR_RTL
        return None

    def extended_language_filter(self, lang_range: str, lang_tag: str) -> bool:
        """Filter the language tags."""

        match = True
        lang_range = RE_WILD_STRIP.sub('-', lang_range).lower()
        ranges = lang_range.split('-')
        subtags = lang_tag.lower().split('-')
        length = len(ranges)
        slength = len(subtags)
        rindex = 0
        sindex = 0
        r = ranges[rindex]
        s = subtags[sindex]

        # Empty specified language should match unspecified language attributes
        if length == 1 and slength == 1 and not r and r == s:
            return True

        # Primary tag needs to match
        if (r != '*' and r != s) or (r == '*' and slength == 1 and not s):
            match = False

        rindex += 1
        sindex += 1

        # Match until we run out of ranges
        while match and rindex < length:
            r = ranges[rindex]
            try:
                s = subtags[sindex]
            except IndexError:
                # Ran out of subtags,
                # but we still have ranges
                match = False
                continue

            # Empty range
            if not r:
                match = False
                continue

            # Matched range
            elif s == r:
                rindex += 1

            # Implicit wildcard cannot match
            # singletons
            elif len(s) == 1:
                match = False
                continue

            # Implicitly matched, so grab next subtag
            sindex += 1

        return match

    def match_attribute_name(
        self,
        el: bs4.Tag,
        attr: str,
        prefix: str | None
    ) -> str | Sequence[str] | None:
        """Match attribute name and return value if it exists."""

        value = None
        if self.supports_namespaces():
            value = None
            # If we have not defined namespaces, we can't very well find them, so don't bother trying.
            if prefix:
                ns = self.namespaces.get(prefix)
                if ns is None and prefix != '*':
                    return None
            else:
                ns = None

            for k, v in self.iter_attributes(el):

                # Get attribute parts
                namespace, name = self.split_namespace(el, k)

                # Can't match a prefix attribute as we haven't specified one to match
                # Try to match it normally as a whole `p:a` as selector may be trying `p\:a`.
                if ns is None:
                    if (self.is_xml and attr == k) or (not self.is_xml and util.lower(attr) == util.lower(k)):
                        value = v
                        break
                    # Coverage is not finding this even though it is executed.
                    # Adding a print statement before this (and erasing coverage) causes coverage to find the line.
                    # Ignore the false positive message.
                    continue  # pragma: no cover

                # We can't match our desired prefix attribute as the attribute doesn't have a prefix
                if namespace is None or (ns != namespace and prefix != '*'):
                    continue

                # The attribute doesn't match.
                if (util.lower(attr) != util.lower(name)) if not self.is_xml else (attr != name):
                    continue

                value = v
                break
        else:
            for k, v in self.iter_attributes(el):
                if util.lower(attr) != util.lower(k):
                    continue
                value = v
                break
        return value

    def match_namespace(self, el: bs4.Tag, tag: ct.SelectorTag) -> bool:
        """Match the namespace of the element."""

        match = True
        namespace = self.get_tag_ns(el)
        default_namespace = self.namespaces.get('')
        tag_ns = '' if tag.prefix is None else self.namespaces.get(tag.prefix)
        # We must match the default namespace if one is not provided
        if tag.prefix is None and (default_namespace is not None and namespace != default_namespace):
            match = False
        # If we specified `|tag`, we must not have a namespace.
        elif (tag.prefix is not None and tag.prefix == '' and namespace):
            match = False
        # Verify prefix matches
        elif (
            tag.prefix and
            tag.prefix != '*' and (tag_ns is None or namespace != tag_ns)
        ):
            match = False
        return match

    def match_attributes(self, el: bs4.Tag, attributes: tuple[ct.SelectorAttribute, ...]) -> bool:
        """Match attributes."""

        match = True
        if attributes:
            for a in attributes:
                temp = self.match_attribute_name(el, a.attribute, a.prefix)
                pattern = a.xml_type_pattern if self.is_xml and a.xml_type_pattern else a.pattern
                if temp is None:
                    match = False
                    break
                value = temp if isinstance(temp, str) else ' '.join(temp)
                if pattern is None:
                    continue
                elif pattern.match(value) is None:
                    match = False
                    break
        return match

    def match_tagname(self, el: bs4.Tag, tag: ct.SelectorTag) -> bool:
        """Match tag name."""

        name = (util.lower(tag.name) if not self.is_xml and tag.name is not None else tag.name)
        return not (
            name is not None and
            name not in (self.get_tag(el), '*')
        )

    def match_tag(self, el: bs4.Tag, tag: ct.SelectorTag | None) -> bool:
        """Match the tag."""

        match = True
        if tag is not None:
            # Verify namespace
            if not self.match_namespace(el, tag):
                match = False
            if not self.match_tagname(el, tag):
                match = False
        return match

    def match_past_relations(self, el: bs4.Tag, relation: ct.SelectorList) -> bool:
        """Match past relationship."""

        found = False
        # I don't think this can ever happen, but it makes `mypy` happy
        if isinstance(relation[0], ct.SelectorNull):  # pragma: no cover
            return found

        if relation[0].rel_type == REL_PARENT:
            parent = self.get_parent(el, no_iframe=self.iframe_restrict)
            while not found and parent:
                found = self.match_selectors(parent, relation)
                parent = self.get_parent(parent, no_iframe=self.iframe_restrict)
        elif relation[0].rel_type == REL_CLOSE_PARENT:
            parent = self.get_parent(el, no_iframe=self.iframe_restrict)
            if parent:
                found = self.match_selectors(parent, relation)
        elif relation[0].rel_type == REL_SIBLING:
            sibling = self.get_previous_tag(el)
            while not found and sibling:
                found = self.match_selectors(sibling, relation)
                sibling = self.get_previous_tag(sibling)
        elif relation[0].rel_type == REL_CLOSE_SIBLING:
            sibling = self.get_previous_tag(el)
            if sibling and self.is_tag(sibling):
                found = self.match_selectors(sibling, relation)
        return found

    def match_future_child(self, parent: bs4.Tag, relation: ct.SelectorList, recursive: bool = False) -> bool:
        """Match future child."""

        match = False
        if recursive:
            children = self.get_tag_descendants  # type: Callable[..., Iterator[bs4.Tag]]
        else:
            children = self.get_tag_children
        for child in children(parent, no_iframe=self.iframe_restrict):
            match = self.match_selectors(child, relation)
            if match:
                break
        return match

    def match_future_relations(self, el: bs4.Tag, relation: ct.SelectorList) -> bool:
        """Match future relationship."""

        found = False
        # I don't think this can ever happen, but it makes `mypy` happy
        if isinstance(relation[0], ct.SelectorNull):  # pragma: no cover
            return found

        if relation[0].rel_type == REL_HAS_PARENT:
            found = self.match_future_child(el, relation, True)
        elif relation[0].rel_type == REL_HAS_CLOSE_PARENT:
            found = self.match_future_child(el, relation)
        elif relation[0].rel_type == REL_HAS_SIBLING:
            sibling = self.get_next_tag(el)
            while not found and sibling:
                found = self.match_selectors(sibling, relation)
                sibling = self.get_next_tag(sibling)
        elif relation[0].rel_type == REL_HAS_CLOSE_SIBLING:
            sibling = self.get_next_tag(el)
            if sibling and self.is_tag(sibling):
                found = self.match_selectors(sibling, relation)
        return found

    def match_relations(self, el: bs4.Tag, relation: ct.SelectorList) -> bool:
        """Match relationship to other elements."""

        found = False

        if isinstance(relation[0], ct.SelectorNull) or relation[0].rel_type is None:
            return found

        if relation[0].rel_type.startswith(':'):
            found = self.match_future_relations(el, relation)
        else:
            found = self.match_past_relations(el, relation)

        return found

    def match_id(self, el: bs4.Tag, ids: tuple[str, ...]) -> bool:
        """Match element's ID."""

        found = True
        for i in ids:
            if i != self.get_attribute_by_name(el, 'id', ''):
                found = False
                break
        return found

    def match_classes(self, el: bs4.Tag, classes: tuple[str, ...]) -> bool:
        """Match element's classes."""

        current_classes = self.get_classes(el)
        found = True
        for c in classes:
            if c not in current_classes:
                found = False
                break
        return found

    def match_root(self, el: bs4.Tag) -> bool:
        """Match element as root."""

        is_root = self.is_root(el)
        if is_root:
            sibling = self.get_previous(el)  # type: Any
            while is_root and sibling is not None:
                if (
                    self.is_tag(sibling) or (self.is_content_string(sibling) and sibling.strip()) or
                    self.is_cdata(sibling)
                ):
                    is_root = False
                else:
                    sibling = self.get_previous(sibling)
        if is_root:
            sibling = self.get_next(el)
            while is_root and sibling is not None:
                if (
                    self.is_tag(sibling) or (self.is_content_string(sibling) and sibling.strip()) or
                    self.is_cdata(sibling)
                ):
                    is_root = False
                else:
                    sibling = self.get_next(sibling)
        return is_root

    def match_scope(self, el: bs4.Tag) -> bool:
        """Match element as scope."""

        return self.scope is el

    def match_nth_tag_type(self, el: bs4.Tag, child: bs4.Tag) -> bool:
        """Match tag type for `nth` matches."""

        return (
            (self.get_tag(child) == self.get_tag(el)) and
            (self.get_tag_ns(child) == self.get_tag_ns(el))
        )

    def match_nth(self, el: bs4.Tag, nth: tuple[ct.SelectorNth, ...]) -> bool:
        """Match `nth` elements."""

        matched = True

        for n in nth:
            matched = False
            if n.selectors and not self.match_selectors(el, n.selectors):
                break
            parent = self.get_parent(el)  # type: bs4.Tag | None
            if parent is None:
                parent = cast('bs4.Tag', self.create_fake_parent(el))
            last = n.last
            last_index = len(parent) - 1
            index = last_index if last else 0
            relative_index = 0
            a = n.a
            b = n.b
            var = n.n
            count = 0
            count_incr = 1
            factor = -1 if last else 1
            idx = last_idx = a * count + b if var else a

            # We can only adjust bounds within a variable index
            if var:
                # Abort if our nth index is out of bounds and only getting further out of bounds as we increment.
                # Otherwise, increment to try to get in bounds.
                adjust = None
                while idx < 1 or idx > last_index:
                    if idx < 0:
                        diff_low = 0 - idx
                        if adjust is not None and adjust == 1:
                            break
                        adjust = -1
                        count += count_incr
                        idx = last_idx = a * count + b if var else a
                        diff = 0 - idx
                        if diff >= diff_low:
                            break
                    else:
                        diff_high = idx - last_index
                        if adjust is not None and adjust == -1:
                            break
                        adjust = 1
                        count += count_incr
                        idx = last_idx = a * count + b if var else a
                        diff = idx - last_index
                        if diff >= diff_high:
                            break
                        diff_high = diff

                # If a < 0, our count is working backwards, so floor the index by increasing the count.
                # Find the count that yields the lowest, in bound value and use that.
                # Lastly reverse count increment so that we'll increase our index.
                lowest = count
                if a < 0:
                    while idx >= 1:
                        lowest = count
                        count += count_incr
                        idx = last_idx = a * count + b if var else a
                    count_incr = -1
                count = lowest
                idx = last_idx = a * count + b if var else a

            # Evaluate elements while our calculated nth index is still in range
            while 1 <= idx <= last_index + 1:
                child = None  # type: bs4.element.PageElement | None
                # Evaluate while our child index is still in range.
                for child in self.get_children(parent, start=index, reverse=factor < 0):
                    index += factor
                    if not isinstance(child, bs4.Tag):
                        continue
                    # Handle `of S` in `nth-child`
                    if n.selectors and not self.match_selectors(child, n.selectors):
                        continue
                    # Handle `of-type`
                    if n.of_type and not self.match_nth_tag_type(el, child):
                        continue
                    relative_index += 1
                    if relative_index == idx:
                        if child is el:
                            matched = True
                        else:
                            break
                    if child is el:
                        break
                if child is el:
                    break
                last_idx = idx
                count += count_incr
                if count < 0:
                    # Count is counting down and has now ventured into invalid territory.
                    break
                idx = a * count + b if var else a
                if last_idx == idx:
                    break
            if not matched:
                break
        return matched

    def match_empty(self, el: bs4.Tag) -> bool:
        """Check if element is empty (if requested)."""

        is_empty = True
        for child in self.get_children(el):
            if self.is_tag(child):
                is_empty = False
                break
            elif self.is_content_string(child) and RE_NOT_EMPTY.search(child):  # type: ignore[call-overload]
                is_empty = False
                break
        return is_empty

    def match_subselectors(self, el: bs4.Tag, selectors: tuple[ct.SelectorList, ...]) -> bool:
        """Match selectors."""

        match = True
        for sel in selectors:
            if not self.match_selectors(el, sel):
                match = False
        return match

    def match_contains(self, el: bs4.Tag, contains: tuple[ct.SelectorContains, ...]) -> bool:
        """Match element if it contains text."""

        match = True
        content = None  # type: str | Sequence[str] | None
        for contain_list in contains:
            if content is None:
                if contain_list.own:
                    content = self.get_own_text(el, no_iframe=self.is_html)
                else:
                    content = self.get_text(el, no_iframe=self.is_html)
            found = False
            for text in contain_list.text:
                if contain_list.own:
                    for c in content:
                        if text in c:
                            found = True
                            break
                    if found:
                        break
                else:
                    if text in content:
                        found = True
                        break
            if not found:
                match = False
        return match

    def match_default(self, el: bs4.Tag) -> bool:
        """Match default."""

        match = False

        # Find this input's form
        form = None  # type: bs4.Tag | None
        parent = self.get_parent(el, no_iframe=True)
        while parent and form is None:
            if self.get_tag(parent) == 'form' and self.is_html_tag(parent):
                form = parent
            else:
                parent = self.get_parent(parent, no_iframe=True)

        if form is not None:
            # Look in form cache to see if we've already located its default button
            found_form = False
            for f, t in self.cached_default_forms:
                if f is form:
                    found_form = True
                    if t is el:
                        match = True
                    break

            # We didn't have the form cached, so look for its default button
            if not found_form:
                for child in self.get_tag_descendants(form, no_iframe=True):
                    name = self.get_tag(child)
                    # Can't do nested forms (haven't figured out why we never hit this)
                    if name == 'form':  # pragma: no cover
                        break
                    if name in ('input', 'button'):
                        v = self.get_attribute_by_name(child, 'type', '')
                        if v and util.lower(v) == 'submit':
                            self.cached_default_forms.append((form, child))
                            if el is child:
                                match = True
                            break
        return match

    def match_indeterminate(self, el: bs4.Tag) -> bool:
        """Match default."""

        match = False
        name = cast(str, self.get_attribute_by_name(el, 'name'))

        def get_parent_form(el: bs4.Tag) -> bs4.Tag | None:
            """Find this input's form."""
            form = None
            parent = self.get_parent(el, no_iframe=True)
            while form is None:
                if self.get_tag(parent) == 'form' and self.is_html_tag(parent):
                    form = parent
                    break
                last_parent = parent
                parent = self.get_parent(parent, no_iframe=True)
                if parent is None:
                    form = last_parent
                    break
            return form

        form = get_parent_form(el)

        # Look in form cache to see if we've already evaluated that its fellow radio buttons are indeterminate
        if form is not None:
            found_form = False
            for f, n, i in self.cached_indeterminate_forms:
                if f is form and n == name:
                    found_form = True
                    if i is True:
                        match = True
                    break

            # We didn't have the form cached, so validate that the radio button is indeterminate
            if not found_form:
                checked = False
                for child in self.get_tag_descendants(form, no_iframe=True):
                    if child is el:
                        continue
                    tag_name = self.get_tag(child)
                    if tag_name == 'input':
                        is_radio = False
                        check = False
                        has_name = False
                        for k, v in self.iter_attributes(child):
                            if util.lower(k) == 'type' and util.lower(v) == 'radio':
                                is_radio = True
                            elif util.lower(k) == 'name' and v == name:
                                has_name = True
                            elif util.lower(k) == 'checked':
                                check = True
                            if is_radio and check and has_name and get_parent_form(child) is form:
                                checked = True
                                break
                    if checked:
                        break
                if not checked:
                    match = True
                self.cached_indeterminate_forms.append((form, name, match))

        return match

    def match_lang(self, el: bs4.Tag, langs: tuple[ct.SelectorLang, ...]) -> bool:
        """Match languages."""

        match = False
        has_ns = self.supports_namespaces()
        root = self.root
        has_html_namespace = self.has_html_namespace

        # Walk parents looking for `lang` (HTML) or `xml:lang` XML property.
        parent = el  # type: bs4.Tag | None
        found_lang = None
        last = None
        while not found_lang:
            has_html_ns = self.has_html_ns(parent)
            for k, v in self.iter_attributes(parent):
                attr_ns, attr = self.split_namespace(parent, k)
                if (
                    ((not has_ns or has_html_ns) and (util.lower(k) if not self.is_xml else k) == 'lang') or
                    (
                        has_ns and not has_html_ns and attr_ns == NS_XML and
                        (util.lower(attr) if not self.is_xml and attr is not None else attr) == 'lang'
                    )
                ):
                    found_lang = v
                    break
            last = parent
            parent = self.get_parent(parent, no_iframe=self.is_html)

            if parent is None:
                root = last
                has_html_namespace = self.has_html_ns(root)
                parent = last
                break

        # Use cached meta language.
        if found_lang is None and self.cached_meta_lang:
            for cache in self.cached_meta_lang:
                if root is not None and cast(str, root) is cache[0]:
                    found_lang = cache[1]

        # If we couldn't find a language, and the document is HTML, look to meta to determine language.
        if found_lang is None and (not self.is_xml or (has_html_namespace and root and root.name == 'html')):
            # Find head
            found = False
            for tag in ('html', 'head'):
                found = False
                for child in self.get_tag_children(parent, no_iframe=self.is_html):
                    if self.get_tag(child) == tag and self.is_html_tag(child):
                        found = True
                        parent = child
                        break
                if not found:  # pragma: no cover
                    break

            # Search meta tags
            if found and parent is not None:
                for child2 in parent:
                    if isinstance(child2, bs4.Tag) and self.get_tag(child2) == 'meta' and self.is_html_tag(parent):
                        c_lang = False
                        content = None
                        for k, v in self.iter_attributes(child2):
                            if util.lower(k) == 'http-equiv' and util.lower(v) == 'content-language':
                                c_lang = True
                            if util.lower(k) == 'content':
                                content = v
                            if c_lang and content:
                                found_lang = content
                                self.cached_meta_lang.append((cast(str, root), cast(str, found_lang)))
                                break
                    if found_lang is not None:
                        break
                if found_lang is None:
                    self.cached_meta_lang.append((cast(str, root), ''))

        # If we determined a language, compare.
        if found_lang is not None:
            for patterns in langs:
                match = False
                for pattern in patterns:
                    if self.extended_language_filter(pattern, cast(str, found_lang)):
                        match = True
                if not match:
                    break

        return match

    def match_dir(self, el: bs4.Tag | None, directionality: int) -> bool:
        """Check directionality."""

        # If we have to match both left and right, we can't match either.
        if directionality & ct.SEL_DIR_LTR and directionality & ct.SEL_DIR_RTL:
            return False

        if el is None or not self.is_html_tag(el):
            return False

        # Element has defined direction of left to right or right to left
        direction = DIR_MAP.get(util.lower(self.get_attribute_by_name(el, 'dir', '')), None)
        if direction not in (None, 0):
            return direction == directionality

        # Element is the document element (the root) and no direction assigned, assume left to right.
        is_root = self.is_root(el)
        if is_root and direction is None:
            return ct.SEL_DIR_LTR == directionality

        # If `input[type=telephone]` and no direction is assigned, assume left to right.
        name = self.get_tag(el)
        is_input = name == 'input'
        is_textarea = name == 'textarea'
        is_bdi = name == 'bdi'
        itype = util.lower(self.get_attribute_by_name(el, 'type', '')) if is_input else ''
        if is_input and itype == 'tel' and direction is None:
            return ct.SEL_DIR_LTR == directionality

        # Auto handling for text inputs
        if ((is_input and itype in ('text', 'search', 'tel', 'url', 'email')) or is_textarea) and direction == 0:
            if is_textarea:
                value = ''.join(node for node in self.get_contents(el, no_iframe=True) if self.is_content_string(node))  # type: ignore[misc]
            else:
                value = cast(str, self.get_attribute_by_name(el, 'value', ''))
            if value:
                for c in value:
                    bidi = unicodedata.bidirectional(c)
                    if bidi in ('AL', 'R', 'L'):
                        direction = ct.SEL_DIR_LTR if bidi == 'L' else ct.SEL_DIR_RTL
                        return direction == directionality
                # Assume left to right
                return ct.SEL_DIR_LTR == directionality
            elif is_root:
                return ct.SEL_DIR_LTR == directionality
            return self.match_dir(self.get_parent(el, no_iframe=True), directionality)

        # Auto handling for `bdi` and other non text inputs.
        if (is_bdi and direction is None) or direction == 0:
            direction = self.find_bidi(el)
            if direction is not None:
                return direction == directionality
            elif is_root:
                return ct.SEL_DIR_LTR == directionality
            return self.match_dir(self.get_parent(el, no_iframe=True), directionality)

        # Match parents direction
        return self.match_dir(self.get_parent(el, no_iframe=True), directionality)

    def match_range(self, el: bs4.Tag, condition: int) -> bool:
        """
        Match range.

        Behavior is modeled after what we see in browsers. Browsers seem to evaluate
        if the value is out of range, and if not, it is in range. So a missing value
        will not evaluate out of range; therefore, value is in range. Personally, I
        feel like this should evaluate as neither in or out of range.
        """

        out_of_range = False

        itype = util.lower(self.get_attribute_by_name(el, 'type'))
        mn = Inputs.parse_value(itype, cast(str, self.get_attribute_by_name(el, 'min', None)))
        mx = Inputs.parse_value(itype, cast(str, self.get_attribute_by_name(el, 'max', None)))

        # There is no valid min or max, so we cannot evaluate a range
        if mn is None and mx is None:
            return False

        value = Inputs.parse_value(itype, cast(str, self.get_attribute_by_name(el, 'value', None)))
        if value is not None:
            if itype in ("date", "datetime-local", "month", "week", "number", "range"):
                if mn is not None and value < mn:
                    out_of_range = True
                if not out_of_range and mx is not None and value > mx:
                    out_of_range = True
            elif itype == "time":
                if mn is not None and mx is not None and mn > mx:
                    # Time is periodic, so this is a reversed/discontinuous range
                    if value < mn and value > mx:
                        out_of_range = True
                else:
                    if mn is not None and value < mn:
                        out_of_range = True
                    if not out_of_range and mx is not None and value > mx:
                        out_of_range = True

        return not out_of_range if condition & ct.SEL_IN_RANGE else out_of_range

    def match_defined(self, el: bs4.Tag) -> bool:
        """
        Match defined.

        `:defined` is related to custom elements in a browser.

        - If the document is XML (not XHTML), all tags will match.
        - Tags that are not custom (don't have a hyphen) are marked defined.
        - If the tag has a prefix (without or without a namespace), it will not match.

        This is of course requires the parser to provide us with the proper prefix and namespace info,
        if it doesn't, there is nothing we can do.
        """

        name = self.get_tag(el)
        return (
            name is not None and (
                name.find('-') == -1 or
                name.find(':') != -1 or
                self.get_prefix(el) is not None
            )
        )

    def match_placeholder_shown(self, el: bs4.Tag) -> bool:
        """
        Match placeholder shown according to HTML spec.

        - text area should be checked if they have content. A single newline does not count as content.

        """

        match = False
        content = self.get_text(el)
        if content in ('', '\n'):
            match = True

        return match

    def match_selectors(self, el: bs4.Tag, selectors: ct.SelectorList) -> bool:
        """Check if element matches one of the selectors."""

        match = False
        is_not = selectors.is_not
        is_html = selectors.is_html

        # Internal selector lists that use the HTML flag, will automatically get the `html` namespace.
        if is_html:
            namespaces = self.namespaces
            iframe_restrict = self.iframe_restrict
            self.namespaces = {'html': NS_XHTML}
            self.iframe_restrict = True

        if not is_html or self.is_html:
            for selector in selectors:
                match = is_not
                # We have a un-matchable situation (like `:focus` as you can focus an element in this environment)
                if isinstance(selector, ct.SelectorNull):
                    continue
                # Verify tag matches
                if not self.match_tag(el, selector.tag):
                    continue
                # Verify tag is defined
                if selector.flags & ct.SEL_DEFINED and not self.match_defined(el):
                    continue
                # Verify element is root
                if selector.flags & ct.SEL_ROOT and not self.match_root(el):
                    continue
                # Verify element is scope
                if selector.flags & ct.SEL_SCOPE and not self.match_scope(el):
                    continue
                # Verify element has placeholder shown
                if selector.flags & ct.SEL_PLACEHOLDER_SHOWN and not self.match_placeholder_shown(el):
                    continue
                # Verify `nth` matches
                if not self.match_nth(el, selector.nth):
                    continue
                if selector.flags & ct.SEL_EMPTY and not self.match_empty(el):
                    continue
                # Verify id matches
                if selector.ids and not self.match_id(el, selector.ids):
                    continue
                # Verify classes match
                if selector.classes and not self.match_classes(el, selector.classes):
                    continue
                # Verify attribute(s) match
                if not self.match_attributes(el, selector.attributes):
                    continue
                # Verify ranges
                if selector.flags & RANGES and not self.match_range(el, selector.flags & RANGES):
                    continue
                # Verify language patterns
                if selector.lang and not self.match_lang(el, selector.lang):
                    continue
                # Verify pseudo selector patterns
                if selector.selectors and not self.match_subselectors(el, selector.selectors):
                    continue
                # Verify relationship selectors
                if selector.relation and not self.match_relations(el, selector.relation):
                    continue
                # Validate that the current default selector match corresponds to the first submit button in the form
                if selector.flags & ct.SEL_DEFAULT and not self.match_default(el):
                    continue
                # Validate that the unset radio button is among radio buttons with the same name in a form that are
                # also not set.
                if selector.flags & ct.SEL_INDETERMINATE and not self.match_indeterminate(el):
                    continue
                # Validate element directionality
                if selector.flags & DIR_FLAGS and not self.match_dir(el, selector.flags & DIR_FLAGS):
                    continue
                # Validate that the tag contains the specified text.
                if selector.contains and not self.match_contains(el, selector.contains):
                    continue
                match = not is_not
                break

        # Restore actual namespaces being used for external selector lists
        if is_html:
            self.namespaces = namespaces
            self.iframe_restrict = iframe_restrict

        return match

    def select(self, limit: int = 0) -> Iterator[bs4.Tag]:
        """Match all tags under the targeted tag."""

        lim = None if limit < 1 else limit

        for child in self.get_tag_descendants(self.tag):
            if self.match(child):
                yield child
                if lim is not None:
                    lim -= 1
                    if lim < 1:
                        break

    def closest(self) -> bs4.Tag | None:
        """Match closest ancestor."""

        current = self.tag  # type: bs4.Tag | None
        closest = None
        while closest is None and current is not None:
            if self.match(current):
                closest = current
            else:
                current = self.get_parent(current)
        return closest

    def filter(self) -> list[bs4.Tag]:  # noqa A001
        """Filter tag's children."""

        return [
            tag for tag in self.get_contents(self.tag)
            if isinstance(tag, bs4.Tag) and self.match(tag)
        ]

    def match(self, el: bs4.Tag) -> bool:
        """Match."""

        return not self.is_doc(el) and self.is_tag(el) and self.match_selectors(el, self.selectors)


class SoupSieve(ct.Immutable):
    """Compiled Soup Sieve selector matching object."""

    pattern: str
    selectors: ct.SelectorList
    namespaces: ct.Namespaces | None
    custom: dict[str, str]
    flags: int

    __slots__ = ("pattern", "selectors", "namespaces", "custom", "flags", "_hash")

    def __init__(
        self,
        pattern: str,
        selectors: ct.SelectorList,
        namespaces: ct.Namespaces | None,
        custom: ct.CustomSelectors | None,
        flags: int
    ):
        """Initialize."""

        super().__init__(
            pattern=pattern,
            selectors=selectors,
            namespaces=namespaces,
            custom=custom,
            flags=flags
        )

    def match(self, tag: bs4.Tag) -> bool:
        """Match."""

        return CSSMatch(self.selectors, tag, self.namespaces, self.flags).match(tag)

    def closest(self, tag: bs4.Tag) -> bs4.Tag | None:
        """Match closest ancestor."""

        return CSSMatch(self.selectors, tag, self.namespaces, self.flags).closest()

    def filter(self, iterable: Iterable[bs4.Tag]) -> list[bs4.Tag]:  # noqa A001
        """
        Filter.

        `CSSMatch` can cache certain searches for tags of the same document,
        so if we are given a tag, all tags are from the same document,
        and we can take advantage of the optimization.

        Any other kind of iterable could have tags from different documents or detached tags,
        so for those, we use a new `CSSMatch` for each item in the iterable.
        """

        if isinstance(iterable, bs4.Tag):
            return CSSMatch(self.selectors, iterable, self.namespaces, self.flags).filter()
        else:
            return [node for node in iterable if not CSSMatch.is_navigable_string(node) and self.match(node)]

    def select_one(self, tag: bs4.Tag) -> bs4.Tag | None:
        """Select a single tag."""

        tags = self.select(tag, limit=1)
        return tags[0] if tags else None

    def select(self, tag: bs4.Tag, limit: int = 0) -> list[bs4.Tag]:
        """Select the specified tags."""

        return list(self.iselect(tag, limit))

    def iselect(self, tag: bs4.Tag, limit: int = 0) -> Iterator[bs4.Tag]:
        """Iterate the specified tags."""

        yield from CSSMatch(self.selectors, tag, self.namespaces, self.flags).select(limit)

    def __repr__(self) -> str:  # pragma: no cover
        """Representation."""

        return (
            f"SoupSieve(pattern={self.pattern!r}, namespaces={self.namespaces!r}, "
            f"custom={self.custom!r}, flags={self.flags!r})"
        )

    __str__ = __repr__


ct.pickle_register(SoupSieve)
