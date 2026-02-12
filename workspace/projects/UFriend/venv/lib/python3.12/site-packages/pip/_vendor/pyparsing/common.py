# common.py
from .core import *
from .helpers import DelimitedList, any_open_tag, any_close_tag
from datetime import datetime


# some other useful expressions - using lower-case class name since we are really using this as a namespace
class pyparsing_common:
    """Here are some common low-level expressions that may be useful in
    jump-starting parser development:

    - numeric forms (:class:`integers<integer>`, :class:`reals<real>`,
      :class:`scientific notation<sci_real>`)
    - common :class:`programming identifiers<identifier>`
    - network addresses (:class:`MAC<mac_address>`,
      :class:`IPv4<ipv4_address>`, :class:`IPv6<ipv6_address>`)
    - ISO8601 :class:`dates<iso8601_date>` and
      :class:`datetime<iso8601_datetime>`
    - :class:`UUID<uuid>`
    - :class:`comma-separated list<comma_separated_list>`
    - :class:`url`

    Parse actions:

    - :class:`convert_to_integer`
    - :class:`convert_to_float`
    - :class:`convert_to_date`
    - :class:`convert_to_datetime`
    - :class:`strip_html_tags`
    - :class:`upcase_tokens`
    - :class:`downcase_tokens`

    Example::

        pyparsing_common.number.run_tests('''
            # any int or real number, returned as the appropriate type
            100
            -100
            +100
            3.14159
            6.02e23
            1e-12
            ''')

        pyparsing_common.fnumber.run_tests('''
            # any int or real number, returned as float
            100
            -100
            +100
            3.14159
            6.02e23
            1e-12
            ''')

        pyparsing_common.hex_integer.run_tests('''
            # hex numbers
            100
            FF
            ''')

        pyparsing_common.fraction.run_tests('''
            # fractions
            1/2
            -3/4
            ''')

        pyparsing_common.mixed_integer.run_tests('''
            # mixed fractions
            1
            1/2
            -3/4
            1-3/4
            ''')

        import uuid
        pyparsing_common.uuid.set_parse_action(token_map(uuid.UUID))
        pyparsing_common.uuid.run_tests('''
            # uuid
            12345678-1234-5678-1234-567812345678
            ''')

    prints::

        # any int or real number, returned as the appropriate type
        100
        [100]

        -100
        [-100]

        +100
        [100]

        3.14159
        [3.14159]

        6.02e23
        [6.02e+23]

        1e-12
        [1e-12]

        # any int or real number, returned as float
        100
        [100.0]

        -100
        [-100.0]

        +100
        [100.0]

        3.14159
        [3.14159]

        6.02e23
        [6.02e+23]

        1e-12
        [1e-12]

        # hex numbers
        100
        [256]

        FF
        [255]

        # fractions
        1/2
        [0.5]

        -3/4
        [-0.75]

        # mixed fractions
        1
        [1]

        1/2
        [0.5]

        -3/4
        [-0.75]

        1-3/4
        [1.75]

        # uuid
        12345678-1234-5678-1234-567812345678
        [UUID('12345678-1234-5678-1234-567812345678')]
    """

    convert_to_integer = token_map(int)
    """
    Parse action for converting parsed integers to Python int
    """

    convert_to_float = token_map(float)
    """
    Parse action for converting parsed numbers to Python float
    """

    integer = Word(nums).set_name("integer").set_parse_action(convert_to_integer)
    """expression that parses an unsigned integer, returns an int"""

    hex_integer = (
        Word(hexnums).set_name("hex integer").set_parse_action(token_map(int, 16))
    )
    """expression that parses a hexadecimal integer, returns an int"""

    signed_integer = (
        Regex(r"[+-]?\d+")
        .set_name("signed integer")
        .set_parse_action(convert_to_integer)
    )
    """expression that parses an integer with optional leading sign, returns an int"""

    fraction = (
        signed_integer().set_parse_action(convert_to_float)
        + "/"
        + signed_integer().set_parse_action(convert_to_float)
    ).set_name("fraction")
    """fractional expression of an integer divided by an integer, returns a float"""
    fraction.add_parse_action(lambda tt: tt[0] / tt[-1])

    mixed_integer = (
        fraction | signed_integer + Opt(Opt("-").suppress() + fraction)
    ).set_name("fraction or mixed integer-fraction")
    """mixed integer of the form 'integer - fraction', with optional leading integer, returns float"""
    mixed_integer.add_parse_action(sum)

    real = (
        Regex(r"[+-]?(?:\d+\.\d*|\.\d+)")
        .set_name("real number")
        .set_parse_action(convert_to_float)
    )
    """expression that parses a floating point number and returns a float"""

    sci_real = (
        Regex(r"[+-]?(?:\d+(?:[eE][+-]?\d+)|(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?)")
        .set_name("real number with scientific notation")
        .set_parse_action(convert_to_float)
    )
    """expression that parses a floating point number with optional
    scientific notation and returns a float"""

    # streamlining this expression makes the docs nicer-looking
    number = (sci_real | real | signed_integer).setName("number").streamline()
    """any numeric expression, returns the corresponding Python type"""

    fnumber = (
        Regex(r"[+-]?\d+\.?\d*([eE][+-]?\d+)?")
        .set_name("fnumber")
        .set_parse_action(convert_to_float)
    )
    """any int or real number, returned as float"""

    identifier = Word(identchars, identbodychars).set_name("identifier")
    """typical code identifier (leading alpha or '_', followed by 0 or more alphas, nums, or '_')"""

    ipv4_address = Regex(
        r"(25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(\.(25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}"
    ).set_name("IPv4 address")
    "IPv4 address (``0.0.0.0 - 255.255.255.255``)"

    _ipv6_part = Regex(r"[0-9a-fA-F]{1,4}").set_name("hex_integer")
    _full_ipv6_address = (_ipv6_part + (":" + _ipv6_part) * 7).set_name(
        "full IPv6 address"
    )
    _short_ipv6_address = (
        Opt(_ipv6_part + (":" + _ipv6_part) * (0, 6))
        + "::"
        + Opt(_ipv6_part + (":" + _ipv6_part) * (0, 6))
    ).set_name("short IPv6 address")
    _short_ipv6_address.add_condition(
        lambda t: sum(1 for tt in t if pyparsing_common._ipv6_part.matches(tt)) < 8
    )
    _mixed_ipv6_address = ("::ffff:" + ipv4_address).set_name("mixed IPv6 address")
    ipv6_address = Combine(
        (_full_ipv6_address | _mixed_ipv6_address | _short_ipv6_address).set_name(
            "IPv6 address"
        )
    ).set_name("IPv6 address")
    "IPv6 address (long, short, or mixed form)"

    mac_address = Regex(
        r"[0-9a-fA-F]{2}([:.-])[0-9a-fA-F]{2}(?:\1[0-9a-fA-F]{2}){4}"
    ).set_name("MAC address")
    "MAC address xx:xx:xx:xx:xx (may also have '-' or '.' delimiters)"

    @staticmethod
    def convert_to_date(fmt: str = "%Y-%m-%d"):
        """
        Helper to create a parse action for converting parsed date string to Python datetime.date

        Params -
        - fmt - format to be passed to datetime.strptime (default= ``"%Y-%m-%d"``)

        Example::

            date_expr = pyparsing_common.iso8601_date.copy()
            date_expr.set_parse_action(pyparsing_common.convert_to_date())
            print(date_expr.parse_string("1999-12-31"))

        prints::

            [datetime.date(1999, 12, 31)]
        """

        def cvt_fn(ss, ll, tt):
            try:
                return datetime.strptime(tt[0], fmt).date()
            except ValueError as ve:
                raise ParseException(ss, ll, str(ve))

        return cvt_fn

    @staticmethod
    def convert_to_datetime(fmt: str = "%Y-%m-%dT%H:%M:%S.%f"):
        """Helper to create a parse action for converting parsed
        datetime string to Python datetime.datetime

        Params -
        - fmt - format to be passed to datetime.strptime (default= ``"%Y-%m-%dT%H:%M:%S.%f"``)

        Example::

            dt_expr = pyparsing_common.iso8601_datetime.copy()
            dt_expr.set_parse_action(pyparsing_common.convert_to_datetime())
            print(dt_expr.parse_string("1999-12-31T23:59:59.999"))

        prints::

            [datetime.datetime(1999, 12, 31, 23, 59, 59, 999000)]
        """

        def cvt_fn(s, l, t):
            try:
                return datetime.strptime(t[0], fmt)
            except ValueError as ve:
                raise ParseException(s, l, str(ve))

        return cvt_fn

    iso8601_date = Regex(
        r"(?P<year>\d{4})(?:-(?P<month>\d\d)(?:-(?P<day>\d\d))?)?"
    ).set_name("ISO8601 date")
    "ISO8601 date (``yyyy-mm-dd``)"

    iso8601_datetime = Regex(
        r"(?P<year>\d{4})-(?P<month>\d\d)-(?P<day>\d\d)[T ](?P<hour>\d\d):(?P<minute>\d\d)(:(?P<second>\d\d(\.\d*)?)?)?(?P<tz>Z|[+-]\d\d:?\d\d)?"
    ).set_name("ISO8601 datetime")
    "ISO8601 datetime (``yyyy-mm-ddThh:mm:ss.s(Z|+-00:00)``) - trailing seconds, milliseconds, and timezone optional; accepts separating ``'T'`` or ``' '``"

    uuid = Regex(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}").set_name("UUID")
    "UUID (``xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx``)"

    _html_stripper = any_open_tag.suppress() | any_close_tag.suppress()

    @staticmethod
    def strip_html_tags(s: str, l: int, tokens: ParseResults):
        """Parse action to remove HTML tags from web page HTML source

        Example::

            # strip HTML links from normal text
            text = '<td>More info at the <a href="https://github.com/pyparsing/pyparsing/wiki">pyparsing</a> wiki page</td>'
            td, td_end = make_html_tags("TD")
            table_text = td + SkipTo(td_end).set_parse_action(pyparsing_common.strip_html_tags)("body") + td_end
            print(table_text.parse_string(text).body)

        Prints::

            More info at the pyparsing wiki page
        """
        return pyparsing_common._html_stripper.transform_string(tokens[0])

    _commasepitem = (
        Combine(
            OneOrMore(
                ~Literal(",")
                + ~LineEnd()
                + Word(printables, exclude_chars=",")
                + Opt(White(" \t") + ~FollowedBy(LineEnd() | ","))
            )
        )
        .streamline()
        .set_name("commaItem")
    )
    comma_separated_list = DelimitedList(
        Opt(quoted_string.copy() | _commasepitem, default="")
    ).set_name("comma separated list")
    """Predefined expression of 1 or more printable words or quoted strings, separated by commas."""

    upcase_tokens = staticmethod(token_map(lambda t: t.upper()))
    """Parse action to convert tokens to upper case."""

    downcase_tokens = staticmethod(token_map(lambda t: t.lower()))
    """Parse action to convert tokens to lower case."""

    # fmt: off
    url = Regex(
        # https://mathiasbynens.be/demo/url-regex
        # https://gist.github.com/dperini/729294
        r"(?P<url>" +
        # protocol identifier (optional)
        # short syntax // still required
        r"(?:(?:(?P<scheme>https?|ftp):)?\/\/)" +
        # user:pass BasicAuth (optional)
        r"(?:(?P<auth>\S+(?::\S*)?)@)?" +
        r"(?P<host>" +
        # IP address exclusion
        # private & local networks
        r"(?!(?:10|127)(?:\.\d{1,3}){3})" +
        r"(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})" +
        r"(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})" +
        # IP address dotted notation octets
        # excludes loopback network 0.0.0.0
        # excludes reserved space >= 224.0.0.0
        # excludes network & broadcast addresses
        # (first & last IP address of each class)
        r"(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])" +
        r"(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}" +
        r"(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))" +
        r"|" +
        # host & domain names, may end with dot
        # can be replaced by a shortest alternative
        # (?![-_])(?:[-\w\u00a1-\uffff]{0,63}[^-_]\.)+
        r"(?:" +
        r"(?:" +
        r"[a-z0-9\u00a1-\uffff]" +
        r"[a-z0-9\u00a1-\uffff_-]{0,62}" +
        r")?" +
        r"[a-z0-9\u00a1-\uffff]\." +
        r")+" +
        # TLD identifier name, may end with dot
        r"(?:[a-z\u00a1-\uffff]{2,}\.?)" +
        r")" +
        # port number (optional)
        r"(:(?P<port>\d{2,5}))?" +
        # resource path (optional)
        r"(?P<path>\/[^?# ]*)?" +
        # query string (optional)
        r"(\?(?P<query>[^#]*))?" +
        # fragment (optional)
        r"(#(?P<fragment>\S*))?" +
        r")"
    ).set_name("url")
    """URL (http/https/ftp scheme)"""
    # fmt: on

    # pre-PEP8 compatibility names
    convertToInteger = convert_to_integer
    """Deprecated - use :class:`convert_to_integer`"""
    convertToFloat = convert_to_float
    """Deprecated - use :class:`convert_to_float`"""
    convertToDate = convert_to_date
    """Deprecated - use :class:`convert_to_date`"""
    convertToDatetime = convert_to_datetime
    """Deprecated - use :class:`convert_to_datetime`"""
    stripHTMLTags = strip_html_tags
    """Deprecated - use :class:`strip_html_tags`"""
    upcaseTokens = upcase_tokens
    """Deprecated - use :class:`upcase_tokens`"""
    downcaseTokens = downcase_tokens
    """Deprecated - use :class:`downcase_tokens`"""


_builtin_exprs = [
    v for v in vars(pyparsing_common).values() if isinstance(v, ParserElement)
]
