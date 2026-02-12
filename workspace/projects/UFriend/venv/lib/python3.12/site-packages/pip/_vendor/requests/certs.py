#!/usr/bin/env python

"""
requests.certs
~~~~~~~~~~~~~~

This module returns the preferred default CA certificate bundle. There is
only one — the one from the certifi package.

If you are packaging Requests, e.g., for a Linux distribution or a managed
environment, you can change the definition of where() to return a separately
packaged CA bundle.
"""

import os

if "_PIP_STANDALONE_CERT" not in os.environ:
    from pip._vendor.certifi import where
else:
    def where():
        return os.environ["_PIP_STANDALONE_CERT"]

if __name__ == "__main__":
    print(where())
