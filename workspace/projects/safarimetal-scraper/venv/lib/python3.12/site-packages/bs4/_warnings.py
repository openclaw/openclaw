"""Define some custom warnings."""


class GuessedAtParserWarning(UserWarning):
    """The warning issued when BeautifulSoup has to guess what parser to
    use -- probably because no parser was specified in the constructor.
    """

    MESSAGE: str = """No parser was explicitly specified, so I'm using the best available %(markup_type)s parser for this system ("%(parser)s"). This usually isn't a problem, but if you run this code on another system, or in a different virtual environment, it may use a different parser and behave differently.

The code that caused this warning is on line %(line_number)s of the file %(filename)s. To get rid of this warning, pass the additional argument 'features="%(parser)s"' to the BeautifulSoup constructor.
"""


class UnusualUsageWarning(UserWarning):
    """A superclass for warnings issued when Beautiful Soup sees
    something that is typically the result of a mistake in the calling
    code, but might be intentional on the part of the user. If it is
    in fact intentional, you can filter the individual warning class
    to get rid of the warning. If you don't like Beautiful Soup
    second-guessing what you are doing, you can filter the
    UnusualUsageWarningclass itself and get rid of these entirely.
    """


class MarkupResemblesLocatorWarning(UnusualUsageWarning):
    """The warning issued when BeautifulSoup is given 'markup' that
    actually looks like a resource locator -- a URL or a path to a file
    on disk.
    """

    #: :meta private:
    GENERIC_MESSAGE: str = """

However, if you want to parse some data that happens to look like a %(what)s, then nothing has gone wrong: you are using Beautiful Soup correctly, and this warning is spurious and can be filtered. To make this warning go away, run this code before calling the BeautifulSoup constructor:

    from bs4 import MarkupResemblesLocatorWarning
    import warnings

    warnings.filterwarnings("ignore", category=MarkupResemblesLocatorWarning)
    """

    URL_MESSAGE: str = (
        """The input passed in on this line looks more like a URL than HTML or XML.

If you meant to use Beautiful Soup to parse the web page found at a certain URL, then something has gone wrong. You should use an Python package like 'requests' to fetch the content behind the URL. Once you have the content as a string, you can feed that string into Beautiful Soup."""
        + GENERIC_MESSAGE
    )

    FILENAME_MESSAGE: str = (
        """The input passed in on this line looks more like a filename than HTML or XML.

If you meant to use Beautiful Soup to parse the contents of a file on disk, then something has gone wrong. You should open the file first, using code like this:

    filehandle = open(your filename)

You can then feed the open filehandle into Beautiful Soup instead of using the filename."""
        + GENERIC_MESSAGE
    )


class AttributeResemblesVariableWarning(UnusualUsageWarning, SyntaxWarning):
    """The warning issued when Beautiful Soup suspects a provided
    attribute name may actually be the misspelled name of a Beautiful
    Soup variable. Generally speaking, this is only used in cases like
    "_class" where it's very unlikely the user would be referencing an
    XML attribute with that name.
    """

    MESSAGE: str = """%(original)r is an unusual attribute name and is a common misspelling for %(autocorrect)r.

If you meant %(autocorrect)r, change your code to use it, and this warning will go away.

If you really did mean to check the %(original)r attribute, this warning is spurious and can be filtered. To make it go away, run this code before creating your BeautifulSoup object:

    from bs4 import AttributeResemblesVariableWarning
    import warnings

    warnings.filterwarnings("ignore", category=AttributeResemblesVariableWarning)
"""


class XMLParsedAsHTMLWarning(UnusualUsageWarning):
    """The warning issued when an HTML parser is used to parse
    XML that is not (as far as we can tell) XHTML.
    """

    MESSAGE: str = """It looks like you're using an HTML parser to parse an XML document.

Assuming this really is an XML document, what you're doing might work, but you should know that using an XML parser will be more reliable. To parse this document as XML, make sure you have the Python package 'lxml' installed, and pass the keyword argument `features="xml"` into the BeautifulSoup constructor.

If you want or need to use an HTML parser on this document, you can make this warning go away by filtering it. To do that, run this code before calling the BeautifulSoup constructor:

    from bs4 import XMLParsedAsHTMLWarning
    import warnings

    warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
"""
