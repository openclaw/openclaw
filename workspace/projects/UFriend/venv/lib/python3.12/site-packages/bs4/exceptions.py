"""Exceptions defined by Beautiful Soup itself."""

from typing import Union


class StopParsing(Exception):
    """Exception raised by a TreeBuilder if it's unable to continue parsing."""


class FeatureNotFound(ValueError):
    """Exception raised by the BeautifulSoup constructor if no parser with the
    requested features is found.
    """


class ParserRejectedMarkup(Exception):
    """An Exception to be raised when the underlying parser simply
    refuses to parse the given markup.
    """

    def __init__(self, message_or_exception: Union[str, Exception]):
        """Explain why the parser rejected the given markup, either
        with a textual explanation or another exception.
        """
        if isinstance(message_or_exception, Exception):
            e = message_or_exception
            message_or_exception = "%s: %s" % (e.__class__.__name__, str(e))
        super(ParserRejectedMarkup, self).__init__(message_or_exception)
