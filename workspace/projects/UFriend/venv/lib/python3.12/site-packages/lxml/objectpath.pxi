################################################################################
# ObjectPath

ctypedef struct _ObjectPath:
    const_xmlChar* href
    const_xmlChar* name
    Py_ssize_t index


cdef object _NO_DEFAULT = object()


cdef class ObjectPath:
    """ObjectPath(path)
    Immutable object that represents a compiled object path.

    Example for a path: 'root.child[1].{other}child[25]'
    """
    cdef readonly object find
    cdef list _path
    cdef object _path_str
    cdef _ObjectPath*  _c_path
    cdef Py_ssize_t _path_len
    def __init__(self, path):
        if python._isString(path):
            self._path = _parse_object_path_string(path)
            self._path_str = path
        else:
            self._path = _parse_object_path_list(path)
            self._path_str = '.'.join(path)
        self._path_len = len(self._path)
        self._c_path = _build_object_path_segments(self._path)
        self.find = self.__call__

    def __dealloc__(self):
        if self._c_path is not NULL:
            python.lxml_free(self._c_path)

    def __str__(self):
        return self._path_str

    def __call__(self, _Element root not None, *_default):
        """Follow the attribute path in the object structure and return the
        target attribute value.

        If it it not found, either returns a default value (if one was passed
        as second argument) or raises AttributeError.
        """
        if _default:
            if len(_default) > 1:
                raise TypeError, "invalid number of arguments: needs one or two"
            default = _default[0]
        else:
            default = _NO_DEFAULT
        return _find_object_path(root, self._c_path, self._path_len, default)

    def hasattr(self, _Element root not None):
        "hasattr(self, root)"
        try:
            _find_object_path(root, self._c_path, self._path_len, _NO_DEFAULT)
        except AttributeError:
            return False
        return True

    def setattr(self, _Element root not None, value):
        """setattr(self, root, value)

        Set the value of the target element in a subtree.

        If any of the children on the path does not exist, it is created.
        """
        _create_object_path(root, self._c_path, self._path_len, 1, value)

    def addattr(self, _Element root not None, value):
        """addattr(self, root, value)

        Append a value to the target element in a subtree.

        If any of the children on the path does not exist, it is created.
        """
        _create_object_path(root, self._c_path, self._path_len, 0, value)


cdef object __MATCH_PATH_SEGMENT = re.compile(
    r"(\.?)\s*(?:\{([^}]*)\})?\s*([^.{}\[\]\s]+)\s*(?:\[\s*([-0-9]+)\s*\])?",
    re.U).match

cdef tuple _RELATIVE_PATH_SEGMENT = (None, None, 0)


cdef list _parse_object_path_string(_path):
    """Parse object path string into a (ns, name, index) list.
    """
    cdef bint has_dot
    cdef unicode path
    new_path = []
    if isinstance(_path, bytes):
        path = (<bytes>_path).decode('ascii')
    elif type(_path) is not unicode:
        path = unicode(_path)
    else:
        path = _path
    path = path.strip()
    if path == '.':
        return [_RELATIVE_PATH_SEGMENT]
    path_pos = 0
    while path:
        match = __MATCH_PATH_SEGMENT(path, path_pos)
        if match is None:
            break

        dot, ns, name, index = match.groups()
        index = int(index) if index else 0
        has_dot = dot == '.'
        if not new_path:
            if has_dot:
                # path '.child' => ignore root
                new_path.append(_RELATIVE_PATH_SEGMENT)
            elif index:
                raise ValueError, "index not allowed on root node"
        elif not has_dot:
            raise ValueError, "invalid path"
        if ns is not None:
            ns = python.PyUnicode_AsUTF8String(ns)
        name = python.PyUnicode_AsUTF8String(name)
        new_path.append( (ns, name, index) )

        path_pos = match.end()
    if not new_path or len(path) > path_pos:
        raise ValueError, "invalid path"
    return new_path


cdef list _parse_object_path_list(path):
    """Parse object path sequence into a (ns, name, index) list.
    """
    new_path = []
    for item in path:
        item = item.strip()
        if not new_path and item == '':
            # path '.child' => ignore root
            ns = name = None
            index = 0
        else:
            ns, name = cetree.getNsTag(item)
            c_name = _xcstr(name)
            index_pos = tree.xmlStrchr(c_name, c'[')
            if index_pos is NULL:
                index = 0
            else:
                index_end = tree.xmlStrchr(index_pos + 1, c']')
                if index_end is NULL:
                    raise ValueError, "index must be enclosed in []"
                index = int(index_pos[1:index_end - index_pos])
                if not new_path and index != 0:
                    raise ValueError, "index not allowed on root node"
                name = <bytes>c_name[:index_pos - c_name]
        new_path.append( (ns, name, index) )
    if not new_path:
        raise ValueError, "invalid path"
    return new_path


cdef _ObjectPath* _build_object_path_segments(list path_list) except NULL:
    cdef _ObjectPath* c_path
    cdef _ObjectPath* c_path_segments
    c_path_segments = <_ObjectPath*>python.lxml_malloc(len(path_list), sizeof(_ObjectPath))
    if c_path_segments is NULL:
        raise MemoryError()
    c_path = c_path_segments
    for href, name, index in path_list:
        c_path[0].href = _xcstr(href) if href is not None else NULL
        c_path[0].name = _xcstr(name) if name is not None else NULL
        c_path[0].index = index
        c_path += 1
    return c_path_segments


cdef _find_object_path(_Element root, _ObjectPath* c_path, Py_ssize_t c_path_len, default_value):
    """Follow the path to find the target element.
    """
    cdef tree.xmlNode* c_node
    cdef Py_ssize_t c_index
    c_node = root._c_node
    c_name = c_path[0].name
    c_href = c_path[0].href
    if c_href is NULL or c_href[0] == c'\0':
        c_href = tree._getNs(c_node)
    if not cetree.tagMatches(c_node, c_href, c_name):
        if default_value is not _NO_DEFAULT:
            return default_value
        else:
            raise ValueError(
                f"root element does not match: need {cetree.namespacedNameFromNsName(c_href, c_name)}, got {root.tag}")

    while c_node is not NULL:
        c_path_len -= 1
        if c_path_len <= 0:
            break

        c_path += 1
        if c_path[0].href is not NULL:
            c_href = c_path[0].href # otherwise: keep parent namespace
        c_name = tree.xmlDictExists(c_node.doc.dict, c_path[0].name, -1)
        if c_name is NULL:
            c_name = c_path[0].name
            c_node = NULL
            break
        c_index = c_path[0].index
        c_node = c_node.last if c_index < 0 else c_node.children
        c_node = _findFollowingSibling(c_node, c_href, c_name, c_index)

    if c_node is not NULL:
        return cetree.elementFactory(root._doc, c_node)
    elif default_value is not _NO_DEFAULT:
        return default_value
    else:
        tag = cetree.namespacedNameFromNsName(c_href, c_name)
        raise AttributeError, f"no such child: {tag}"


cdef _create_object_path(_Element root, _ObjectPath* c_path,
                         Py_ssize_t c_path_len, int replace, value):
    """Follow the path to find the target element, build the missing children
    as needed and set the target element to 'value'.  If replace is true, an
    existing value is replaced, otherwise the new value is added.
    """
    cdef _Element child
    cdef tree.xmlNode* c_node
    cdef tree.xmlNode* c_child
    cdef Py_ssize_t c_index
    if c_path_len == 1:
        raise TypeError, "cannot update root node"

    c_node = root._c_node
    c_name = c_path[0].name
    c_href = c_path[0].href
    if c_href is NULL or c_href[0] == c'\0':
        c_href = tree._getNs(c_node)
    if not cetree.tagMatches(c_node, c_href, c_name):
        raise ValueError(
            f"root element does not match: need {cetree.namespacedNameFromNsName(c_href, c_name)}, got {root.tag}")

    while c_path_len > 1:
        c_path_len -= 1
        c_path += 1
        if c_path[0].href is not NULL:
            c_href = c_path[0].href # otherwise: keep parent namespace
        c_index = c_path[0].index
        c_name = tree.xmlDictExists(c_node.doc.dict, c_path[0].name, -1)
        if c_name is NULL:
            c_name = c_path[0].name
            c_child = NULL
        else:
            c_child = c_node.last if c_index < 0 else c_node.children
            c_child = _findFollowingSibling(c_child, c_href, c_name, c_index)

        if c_child is not NULL:
            c_node = c_child
        elif c_index != 0:
            raise TypeError, "creating indexed path attributes is not supported"
        elif c_path_len == 1:
            _appendValue(cetree.elementFactory(root._doc, c_node),
                         cetree.namespacedNameFromNsName(c_href, c_name),
                         value)
            return
        else:
            child = cetree.makeSubElement(
                cetree.elementFactory(root._doc, c_node),
                cetree.namespacedNameFromNsName(c_href, c_name),
                None, None, None, None)
            c_node = child._c_node

    # if we get here, the entire path was already there
    if replace:
        element = cetree.elementFactory(root._doc, c_node)
        _replaceElement(element, value)
    else:
        _appendValue(cetree.elementFactory(root._doc, c_node.parent),
                     cetree.namespacedName(c_node), value)


cdef list _build_descendant_paths(tree.xmlNode* c_node, prefix_string):
    """Returns a list of all descendant paths.
    """
    cdef list path, path_list
    tag = cetree.namespacedName(c_node)
    if prefix_string:
        if prefix_string[-1] != '.':
            prefix_string += '.'
        prefix_string = prefix_string + tag
    else:
        prefix_string = tag
    path = [prefix_string]
    path_list = []
    _recursive_build_descendant_paths(c_node, path, path_list)
    return path_list


cdef int _recursive_build_descendant_paths(tree.xmlNode* c_node,
                                           list path, list path_list) except -1:
    """Fills the list 'path_list' with all descendant paths, initial prefix
    being in the list 'path'.
    """
    cdef tree.xmlNode* c_child
    tags = {}
    path_list.append('.'.join(path))
    c_href = tree._getNs(c_node)
    c_child = c_node.children
    while c_child is not NULL:
        while c_child.type != tree.XML_ELEMENT_NODE:
            c_child = c_child.next
            if c_child is NULL:
                return 0
        if c_href is tree._getNs(c_child):
            tag = pyunicode(c_child.name)
        elif c_href is not NULL and tree._getNs(c_child) is NULL:
            # special case: parent has namespace, child does not
            tag = '{}' + pyunicode(c_child.name)
        else:
            tag = cetree.namespacedName(c_child)
        count = tags.get(tag)
        if count is None:
            tags[tag] = 1
        else:
            tags[tag] = count + 1
            tag += f'[{count}]'
        path.append(tag)
        _recursive_build_descendant_paths(c_child, path, path_list)
        del path[-1]
        c_child = c_child.next
    return 0
