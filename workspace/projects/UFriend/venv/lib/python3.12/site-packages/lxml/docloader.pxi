# Custom resolver API

ctypedef enum _InputDocumentDataType:
    PARSER_DATA_INVALID
    PARSER_DATA_EMPTY
    PARSER_DATA_STRING
    PARSER_DATA_FILENAME
    PARSER_DATA_FILE

@cython.final
@cython.internal
cdef class _InputDocument:
    cdef _InputDocumentDataType _type
    cdef bytes _data_bytes
    cdef object _filename
    cdef object _file
    cdef bint _close_file

    def __cinit__(self):
        self._type = PARSER_DATA_INVALID


cdef class Resolver:
    "This is the base class of all resolvers."
    def resolve(self, system_url, public_id, context):
        """resolve(self, system_url, public_id, context)

        Override this method to resolve an external source by
        ``system_url`` and ``public_id``.  The third argument is an
        opaque context object.

        Return the result of one of the ``resolve_*()`` methods.
        """
        return None

    def resolve_empty(self, context):
        """resolve_empty(self, context)

        Return an empty input document.

        Pass context as parameter.
        """
        cdef _InputDocument doc_ref
        doc_ref = _InputDocument()
        doc_ref._type = PARSER_DATA_EMPTY
        return doc_ref

    def resolve_string(self, string, context, *, base_url=None):
        """resolve_string(self, string, context, base_url=None)

        Return a parsable string as input document.

        Pass data string and context as parameters.  You can pass the
        source URL or filename through the ``base_url`` keyword
        argument.
        """
        cdef _InputDocument doc_ref
        if isinstance(string, unicode):
            string = (<unicode>string).encode('utf8')
        elif not isinstance(string, bytes):
            raise TypeError, "argument must be a byte string or unicode string"
        doc_ref = _InputDocument()
        doc_ref._type = PARSER_DATA_STRING
        doc_ref._data_bytes = string
        if base_url is not None:
            doc_ref._filename = _encodeFilename(base_url)
        return doc_ref

    def resolve_filename(self, filename, context):
        """resolve_filename(self, filename, context)

        Return the name of a parsable file as input document.

        Pass filename and context as parameters.  You can also pass a
        URL with an HTTP, FTP or file target.
        """
        cdef _InputDocument doc_ref
        doc_ref = _InputDocument()
        doc_ref._type = PARSER_DATA_FILENAME
        doc_ref._filename = _encodeFilename(filename)
        return doc_ref

    def resolve_file(self, f, context, *, base_url=None, bint close=True):
        """resolve_file(self, f, context, base_url=None, close=True)

        Return an open file-like object as input document.

        Pass open file and context as parameters.  You can pass the
        base URL or filename of the file through the ``base_url``
        keyword argument.  If the ``close`` flag is True (the
        default), the file will be closed after reading.

        Note that using ``.resolve_filename()`` is more efficient,
        especially in threaded environments.
        """
        cdef _InputDocument doc_ref
        try:
            f.read
        except AttributeError:
            raise TypeError, "Argument is not a file-like object"
        doc_ref = _InputDocument()
        doc_ref._type = PARSER_DATA_FILE
        if base_url is not None:
            doc_ref._filename = _encodeFilename(base_url)
        else:
            doc_ref._filename = _getFilenameForFile(f)
        doc_ref._close_file = close
        doc_ref._file = f
        return doc_ref

@cython.final
@cython.internal
cdef class _ResolverRegistry:
    cdef object _resolvers
    cdef Resolver _default_resolver
    def __cinit__(self, Resolver default_resolver=None):
        self._resolvers = set()
        self._default_resolver = default_resolver

    def add(self, Resolver resolver not None):
        """add(self, resolver)

        Register a resolver.

        For each requested entity, the 'resolve' method of the resolver will
        be called and the result will be passed to the parser.  If this method
        returns None, the request will be delegated to other resolvers or the
        default resolver.  The resolvers will be tested in an arbitrary order
        until the first match is found.
        """
        self._resolvers.add(resolver)

    def remove(self, resolver):
        "remove(self, resolver)"
        self._resolvers.discard(resolver)

    cdef _ResolverRegistry _copy(self):
        cdef _ResolverRegistry registry
        registry = _ResolverRegistry(self._default_resolver)
        registry._resolvers = self._resolvers.copy()
        return registry

    def copy(self):
        "copy(self)"
        return self._copy()

    def resolve(self, system_url, public_id, context):
        "resolve(self, system_url, public_id, context)"
        for resolver in self._resolvers:
            result = resolver.resolve(system_url, public_id, context)
            if result is not None:
                return result
        if self._default_resolver is None:
            return None
        return self._default_resolver.resolve(system_url, public_id, context)

    def __repr__(self):
        return repr(self._resolvers)


@cython.internal
cdef class _ResolverContext(_ExceptionContext):
    cdef _ResolverRegistry _resolvers
    cdef _TempStore _storage

    cdef int clear(self) except -1:
        _ExceptionContext.clear(self)
        self._storage.clear()
        return 0


cdef _initResolverContext(_ResolverContext context,
                          _ResolverRegistry resolvers):
    if resolvers is None:
        context._resolvers = _ResolverRegistry()
    else:
        context._resolvers = resolvers
    context._storage = _TempStore()
