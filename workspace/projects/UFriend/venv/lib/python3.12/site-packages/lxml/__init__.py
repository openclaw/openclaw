# this is a package

__version__ = "6.0.2"


def get_include():
    """
    Returns a list of header include paths (for lxml itself, libxml2
    and libxslt) needed to compile C code against lxml if it was built
    with statically linked libraries.
    """
    import os
    lxml_path = __path__[0]
    include_path = os.path.join(lxml_path, 'includes')
    includes = [include_path, lxml_path]

    for name in os.listdir(include_path):
        path = os.path.join(include_path, name)
        if os.path.isdir(path):
            includes.append(path)

    return includes
