# iterparse -- event-driven parsing

DEF __ITERPARSE_CHUNK_SIZE = 32768

cdef class iterparse:
    """iterparse(self, source, events=("end",), tag=None, \
                  attribute_defaults=False, dtd_validation=False, \
                  load_dtd=False, no_network=True, remove_blank_text=False, \
                  remove_comments=False, remove_pis=False, encoding=None, \
                  html=False, recover=None, huge_tree=False, schema=None)

    Incremental parser.

    Parses XML into a tree and generates tuples (event, element) in a
    SAX-like fashion. ``event`` is any of 'start', 'end', 'start-ns',
    'end-ns'.

    For 'start' and 'end', ``element`` is the Element that the parser just
    found opening or closing.  For 'start-ns', it is a tuple (prefix, URI) of
    a new namespace declaration.  For 'end-ns', it is simply None.  Note that
    all start and end events are guaranteed to be properly nested.

    The keyword argument ``events`` specifies a sequence of event type names
    that should be generated.  By default, only 'end' events will be
    generated.

    The additional ``tag`` argument restricts the 'start' and 'end' events to
    those elements that match the given tag.  The ``tag`` argument can also be
    a sequence of tags to allow matching more than one tag.  By default,
    events are generated for all elements.  Note that the 'start-ns' and
    'end-ns' events are not impacted by this restriction.

    The other keyword arguments in the constructor are mainly based on the
    libxml2 parser configuration.  A DTD will also be loaded if validation or
    attribute default values are requested.

    Available boolean keyword arguments:
     - attribute_defaults: read default attributes from DTD
     - dtd_validation: validate (if DTD is available)
     - load_dtd: use DTD for parsing
     - no_network: prevent network access for related files
     - remove_blank_text: discard blank text nodes
     - remove_comments: discard comments
     - remove_pis: discard processing instructions
     - strip_cdata: replace CDATA sections by normal text content (default: 
       True for XML, ignored otherwise)
     - compact: safe memory for short text content (default: True)
     - resolve_entities: replace entities by their text value (default: True)
     - huge_tree: disable security restrictions and support very deep trees
                  and very long text content (only affects libxml2 2.7+)
     - html: parse input as HTML (default: XML)
     - recover: try hard to parse through broken input (default: True for HTML,
                False otherwise)

    Other keyword arguments:
     - encoding: override the document encoding
     - schema: an XMLSchema to validate against
    """
    cdef _FeedParser _parser
    cdef object _tag
    cdef object _events
    cdef readonly object root
    cdef object _source
    cdef object _filename
    cdef object _error
    cdef bint _close_source_after_read

    def __init__(self, source, events=("end",), *, tag=None,
                 attribute_defaults=False, dtd_validation=False,
                 load_dtd=False, no_network=True, remove_blank_text=False,
                 compact=True, resolve_entities=True, remove_comments=False,
                 remove_pis=False, strip_cdata=True, encoding=None,
                 html=False, recover=None, huge_tree=False, collect_ids=True,
                 XMLSchema schema=None):
        if not hasattr(source, 'read'):
            source = _getFSPathOrObject(source)
            self._filename = source
            self._source = open(source, 'rb')
            self._close_source_after_read = True
        else:
            self._filename = _getFilenameForFile(source)
            self._source = source
            self._close_source_after_read = False

        if recover is None:
            recover = html

        if html:
            # make sure we're not looking for namespaces
            events = [event for event in events
                      if event not in ('start-ns', 'end-ns')]
            parser = HTMLPullParser(
                events,
                tag=tag,
                recover=recover,
                base_url=self._filename,
                encoding=encoding,
                remove_blank_text=remove_blank_text,
                remove_comments=remove_comments,
                remove_pis=remove_pis,
                no_network=no_network,
                target=None,  # TODO
                schema=schema,
                compact=compact)
        else:
            parser = XMLPullParser(
                events,
                tag=tag,
                recover=recover,
                base_url=self._filename,
                encoding=encoding,
                attribute_defaults=attribute_defaults,
                dtd_validation=dtd_validation,
                load_dtd=load_dtd,
                no_network=no_network,
                schema=schema,
                huge_tree=huge_tree,
                remove_blank_text=remove_blank_text,
                resolve_entities=resolve_entities,
                remove_comments=remove_comments,
                remove_pis=remove_pis,
                strip_cdata=strip_cdata,
                collect_ids=True,
                target=None,  # TODO
                compact=compact)

        self._events = parser.read_events()
        self._parser = parser

    @property
    def error_log(self):
        """The error log of the last (or current) parser run.
        """
        return self._parser.feed_error_log

    @property
    def resolvers(self):
        """The custom resolver registry of the last (or current) parser run.
        """
        return self._parser.resolvers

    @property
    def version(self):
        """The version of the underlying XML parser."""
        return self._parser.version

    def set_element_class_lookup(self, ElementClassLookup lookup = None):
        """set_element_class_lookup(self, lookup = None)

        Set a lookup scheme for element classes generated from this parser.

        Reset it by passing None or nothing.
        """
        self._parser.set_element_class_lookup(lookup)

    def makeelement(self, _tag, attrib=None, nsmap=None, **_extra):
        """makeelement(self, _tag, attrib=None, nsmap=None, **_extra)

        Creates a new element associated with this parser.
        """
        self._parser.makeelement(
            _tag, attrib=None, nsmap=None, **_extra)

    @cython.final
    cdef _close_source(self):
        if self._source is None:
            return
        if not self._close_source_after_read:
            self._source = None
            return
        try:
            close = self._source.close
        except AttributeError:
            close = None
        finally:
            self._source = None
        if close is not None:
            close()

    def __iter__(self):
        return self

    def __next__(self):
        try:
            return next(self._events)
        except StopIteration:
            pass
        context = <_SaxParserContext>self._parser._getPushParserContext()
        if self._source is not None:
            done = False
            while not done:
                try:
                    done = self._read_more_events(context)
                    return next(self._events)
                except StopIteration:
                    pass  # no events yet
                except Exception as e:
                    self._error = e
                    self._close_source()
                    try:
                        return next(self._events)
                    except StopIteration:
                        break
        # nothing left to read or return
        if self._error is not None:
            error = self._error
            self._error = None
            raise error
        if (context._validator is not None
                and not context._validator.isvalid()):
            _raiseParseError(context._c_ctxt, self._filename,
                             context._error_log)
        # no errors => all done
        raise StopIteration

    @cython.final
    cdef bint _read_more_events(self, _SaxParserContext context) except -123:
        data = self._source.read(__ITERPARSE_CHUNK_SIZE)
        if not isinstance(data, bytes):
            self._close_source()
            raise TypeError("reading file objects must return bytes objects")
        if not data:
            try:
                self.root = self._parser.close()
            finally:
                self._close_source()
            return True
        self._parser.feed(data)
        return False


cdef enum _IterwalkSkipStates:
    IWSKIP_NEXT_IS_START
    IWSKIP_SKIP_NEXT
    IWSKIP_CAN_SKIP
    IWSKIP_CANNOT_SKIP


cdef class iterwalk:
    """iterwalk(self, element_or_tree, events=("end",), tag=None)

    A tree walker that generates events from an existing tree as if it
    was parsing XML data with ``iterparse()``.

    Just as for ``iterparse()``, the ``tag`` argument can be a single tag or a
    sequence of tags.

    After receiving a 'start' or 'start-ns' event, the children and
    descendants of the current element can be excluded from iteration
    by calling the ``skip_subtree()`` method.
    """
    cdef _MultiTagMatcher _matcher
    cdef list   _node_stack
    cdef list   _events
    cdef object _pop_event
    cdef object _include_siblings
    cdef int    _index
    cdef int    _event_filter
    cdef _IterwalkSkipStates _skip_state

    def __init__(self, element_or_tree, events=("end",), tag=None):
        cdef _Element root
        cdef int ns_count
        root = _rootNodeOrRaise(element_or_tree)
        self._event_filter = _buildParseEventFilter(events)
        if tag is None or tag == '*':
            self._matcher = None
        else:
            self._matcher = _MultiTagMatcher.__new__(_MultiTagMatcher, tag)
        self._node_stack  = []
        self._events = []
        self._pop_event = self._events.pop
        self._skip_state = IWSKIP_CANNOT_SKIP  # ignore all skip requests by default

        if self._event_filter:
            self._index = 0
            if self._matcher is not None and self._event_filter & PARSE_EVENT_FILTER_START:
                self._matcher.cacheTags(root._doc)

            # When processing an ElementTree, add events for the preceding comments/PIs.
            if self._event_filter & (PARSE_EVENT_FILTER_COMMENT | PARSE_EVENT_FILTER_PI):
                if isinstance(element_or_tree, _ElementTree):
                    self._include_siblings = root
                    for elem in list(root.itersiblings(preceding=True))[::-1]:
                        if self._event_filter & PARSE_EVENT_FILTER_COMMENT and elem.tag is Comment:
                            self._events.append(('comment', elem))
                        elif self._event_filter & PARSE_EVENT_FILTER_PI and elem.tag is PI:
                            self._events.append(('pi', elem))

            ns_count = self._start_node(root)
            self._node_stack.append( (root, ns_count) )
        else:
            self._index = -1

    def __iter__(self):
        return self

    def __next__(self):
        cdef xmlNode* c_child
        cdef _Element node
        cdef _Element next_node
        cdef int ns_count = 0
        if self._events:
            return self._next_event()
        if self._matcher is not None and self._index >= 0:
            node = self._node_stack[self._index][0]
            self._matcher.cacheTags(node._doc)

        # find next node
        while self._index >= 0:
            node = self._node_stack[self._index][0]

            if self._skip_state == IWSKIP_SKIP_NEXT:
                c_child = NULL
            else:
                c_child = self._process_non_elements(
                    node._doc, _findChildForwards(node._c_node, 0))
            self._skip_state = IWSKIP_CANNOT_SKIP

            while c_child is NULL:
                # back off through parents
                self._index -= 1
                node = self._end_node()
                if self._index < 0:
                    break
                c_child = self._process_non_elements(
                    node._doc, _nextElement(node._c_node))

            if c_child is not NULL:
                next_node = _elementFactory(node._doc, c_child)
                if self._event_filter & (PARSE_EVENT_FILTER_START |
                                         PARSE_EVENT_FILTER_START_NS):
                    ns_count = self._start_node(next_node)
                elif self._event_filter & PARSE_EVENT_FILTER_END_NS:
                    ns_count = _countNsDefs(next_node._c_node)
                self._node_stack.append( (next_node, ns_count) )
                self._index += 1
            if self._events:
                return self._next_event()

        if self._include_siblings is not None:
            node, self._include_siblings = self._include_siblings, None
            self._process_non_elements(node._doc, _nextElement(node._c_node))
            if self._events:
                return self._next_event()

        raise StopIteration

    @cython.final
    cdef xmlNode* _process_non_elements(self, _Document doc, xmlNode* c_node):
        while c_node is not NULL and c_node.type != tree.XML_ELEMENT_NODE:
            if c_node.type == tree.XML_COMMENT_NODE:
                if self._event_filter & PARSE_EVENT_FILTER_COMMENT:
                    self._events.append(
                        ("comment", _elementFactory(doc, c_node)))
                c_node = _nextElement(c_node)
            elif c_node.type == tree.XML_PI_NODE:
                if self._event_filter & PARSE_EVENT_FILTER_PI:
                    self._events.append(
                        ("pi", _elementFactory(doc, c_node)))
                c_node = _nextElement(c_node)
            else:
                break
        return c_node

    @cython.final
    cdef _next_event(self):
        if self._skip_state == IWSKIP_NEXT_IS_START:
            if self._events[0][0] in ('start', 'start-ns'):
                self._skip_state = IWSKIP_CAN_SKIP
        return self._pop_event(0)

    def skip_subtree(self):
        """Prevent descending into the current subtree.
        Instead, the next returned event will be the 'end' event of the current element
        (if included), ignoring any children or descendants.

        This has no effect right after an 'end' or 'end-ns' event.
        """
        if self._skip_state == IWSKIP_CAN_SKIP:
            self._skip_state = IWSKIP_SKIP_NEXT

    @cython.final
    cdef int _start_node(self, _Element node) except -1:
        cdef int ns_count
        if self._event_filter & PARSE_EVENT_FILTER_START_NS:
            ns_count = _appendStartNsEvents(node._c_node, self._events)
            if self._events:
                self._skip_state = IWSKIP_NEXT_IS_START
        elif self._event_filter & PARSE_EVENT_FILTER_END_NS:
            ns_count = _countNsDefs(node._c_node)
        else:
            ns_count = 0
        if self._event_filter & PARSE_EVENT_FILTER_START:
            if self._matcher is None or self._matcher.matches(node._c_node):
                self._events.append( ("start", node) )
                self._skip_state = IWSKIP_NEXT_IS_START
        return ns_count

    @cython.final
    cdef _Element _end_node(self):
        cdef _Element node
        cdef int i, ns_count
        node, ns_count = self._node_stack.pop()
        if self._event_filter & PARSE_EVENT_FILTER_END:
            if self._matcher is None or self._matcher.matches(node._c_node):
                self._events.append( ("end", node) )
        if self._event_filter & PARSE_EVENT_FILTER_END_NS and ns_count:
            event = ("end-ns", None)
            for i in range(ns_count):
                self._events.append(event)
        return node


cdef int _countNsDefs(xmlNode* c_node) noexcept:
    cdef xmlNs* c_ns
    cdef int count
    count = 0
    c_ns = c_node.nsDef
    while c_ns is not NULL:
        count += (c_ns.href is not NULL)
        c_ns = c_ns.next
    return count


cdef int _appendStartNsEvents(xmlNode* c_node, list event_list) except -1:
    cdef xmlNs* c_ns
    cdef int count
    count = 0
    c_ns = c_node.nsDef
    while c_ns is not NULL:
        if c_ns.href:
            ns_tuple = (funicodeOrEmpty(c_ns.prefix),
                        funicode(c_ns.href))
            event_list.append( ("start-ns", ns_tuple) )
            count += 1
        c_ns = c_ns.next
    return count
