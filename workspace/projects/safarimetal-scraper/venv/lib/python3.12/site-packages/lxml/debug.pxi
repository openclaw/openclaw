@cython.final
@cython.internal
cdef class _MemDebug:
    """Debugging support for the memory allocation in libxml2.
    """
    def bytes_used(self):
        """bytes_used(self)

        Returns the total amount of memory (in bytes) currently used by libxml2.
        Note that libxml2 constrains this value to a C int, which limits
        the accuracy on 64 bit systems.
        """
        return tree.xmlMemUsed()

    def blocks_used(self):
        """blocks_used(self)

        Returns the total number of memory blocks currently allocated by libxml2.
        Note that libxml2 constrains this value to a C int, which limits
        the accuracy on 64 bit systems.
        """
        return tree.xmlMemBlocks()

    def dict_size(self):
        """dict_size(self)

        Returns the current size of the global name dictionary used by libxml2
        for the current thread.  Each thread has its own dictionary.
        """
        c_dict = __GLOBAL_PARSER_CONTEXT._getThreadDict(NULL)
        if c_dict is NULL:
            raise MemoryError()
        return tree.xmlDictSize(c_dict)


memory_debugger = _MemDebug()
