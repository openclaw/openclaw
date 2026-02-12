#ifndef HAS_ETREE_DEFS_H
#define HAS_ETREE_DEFS_H

/* quick check for Python/libxml2/libxslt devel setup */
#include "Python.h"
#ifndef PY_VERSION_HEX
#  error the development package of Python (header files etc.) is not installed correctly
#elif PY_VERSION_HEX < 0x03060000
#  error this version of lxml requires Python 3.6 or later
#endif

#include "libxml/xmlversion.h"
#ifndef LIBXML_VERSION
#  error the development package of libxml2 (header files etc.) is not installed correctly
#elif LIBXML_VERSION < 20700
#  error minimum required version of libxml2 is 2.7.0
#endif

#include "libxslt/xsltconfig.h"
#ifndef LIBXSLT_VERSION
#  error the development package of libxslt (header files etc.) is not installed correctly
#elif LIBXSLT_VERSION < 10123
#  error minimum required version of libxslt is 1.1.23
#endif


/* v_arg functions */
#define va_int(ap)     va_arg(ap, int)
#define va_charptr(ap) va_arg(ap, char *)

#ifdef PYPY_VERSION
#    define IS_PYPY 1
#else
#    define IS_PYPY 0
#endif

/* unused */
#define IS_PYTHON2 0
#define IS_PYTHON3 1
#undef LXML_UNICODE_STRINGS
#define LXML_UNICODE_STRINGS 1

#if !IS_PYPY
#  define PyWeakref_LockObject(obj)          (NULL)
#endif

/* Threading is not currently supported by PyPy */
#if IS_PYPY
#  ifndef WITHOUT_THREADING
#    define WITHOUT_THREADING
#  endif
#endif

#if IS_PYPY
#  ifndef PyUnicode_FromFormat
#    define PyUnicode_FromFormat  PyString_FromFormat
#  endif
#  if !defined(PyBytes_FromFormat)
#    ifdef PyString_FromFormat
#      define PyBytes_FromFormat  PyString_FromFormat
#    else
#include <stdarg.h>
static PyObject* PyBytes_FromFormat(const char* format, ...) {
    PyObject *string;
    va_list vargs;
#ifdef HAVE_STDARG_PROTOTYPES
    va_start(vargs, format);
#else
    va_start(vargs);
#endif
    string = PyUnicode_FromFormatV(format, vargs);
    va_end(vargs);
    if (string && PyUnicode_Check(string)) {
        PyObject *bstring = PyUnicode_AsUTF8String(string);
        Py_DECREF(string);
        string = bstring;
    }
    if (string && !PyBytes_CheckExact(string)) {
        Py_DECREF(string);
        string = NULL;
        PyErr_SetString(PyExc_TypeError, "String formatting and encoding failed to return bytes object");
    }
    return string;
}
#    endif
#  endif
#endif

#if PY_VERSION_HEX >= 0x030B00A1
/* Python 3.12 doesn't have wstr Unicode strings any more. */
#undef PyUnicode_GET_DATA_SIZE
#define PyUnicode_GET_DATA_SIZE(ustr)  (0)
#undef PyUnicode_AS_DATA
#define PyUnicode_AS_DATA(ustr)  (NULL)
#undef PyUnicode_IS_READY
#define PyUnicode_IS_READY(ustr)  (1)
#endif

#ifdef WITHOUT_THREADING
#  undef PyEval_SaveThread
#  define PyEval_SaveThread() (NULL)
#  undef PyEval_RestoreThread
#  define PyEval_RestoreThread(state)  if (state); else {}
#  undef PyGILState_Ensure
#  define PyGILState_Ensure() (PyGILState_UNLOCKED)
#  undef PyGILState_Release
#  define PyGILState_Release(state)  if (state); else {}
#  undef  Py_UNBLOCK_THREADS
#  define Py_UNBLOCK_THREADS  _save = NULL;
#  undef  Py_BLOCK_THREADS
#  define Py_BLOCK_THREADS  if (_save); else {}
#endif

#ifdef WITHOUT_THREADING
#  define ENABLE_THREADING 0
#else
#  define ENABLE_THREADING 1
#endif

#if LIBXML_VERSION < 20704
/* FIXME: hack to make new error reporting compile in old libxml2 versions */
#  define xmlStructuredErrorContext NULL
#  define xmlXIncludeProcessTreeFlagsData(n,o,d) xmlXIncludeProcessTreeFlags(n,o)
#endif

/* schematron was added in libxml2 2.6.21 */
#ifdef LIBXML_SCHEMATRON_ENABLED
#  define ENABLE_SCHEMATRON 1
#else
#  define ENABLE_SCHEMATRON 0
#  define XML_SCHEMATRON_OUT_QUIET 0
#  define XML_SCHEMATRON_OUT_XML 0
#  define XML_SCHEMATRON_OUT_ERROR 0
   typedef void xmlSchematron;
   typedef void xmlSchematronParserCtxt;
   typedef void xmlSchematronValidCtxt;
#  define xmlSchematronNewDocParserCtxt(doc) NULL
#  define xmlSchematronNewParserCtxt(file) NULL
#  define xmlSchematronParse(ctxt) NULL
#  define xmlSchematronFreeParserCtxt(ctxt)
#  define xmlSchematronFree(schema)
#  define xmlSchematronNewValidCtxt(schema, options) NULL
#  define xmlSchematronValidateDoc(ctxt, doc) 0
#  define xmlSchematronFreeValidCtxt(ctxt)
#  define xmlSchematronSetValidStructuredErrors(ctxt, errorfunc, data)
#endif

#if LIBXML_VERSION < 20708
#  define HTML_PARSE_NODEFDTD 4
#endif
#if LIBXML_VERSION < 20900
#  define XML_PARSE_BIG_LINES 0x400000
#endif
#if LIBXML_VERSION < 21300
#  define XML_PARSE_NO_XXE 0x800000
#endif
#if LIBXML_VERSION < 21400
#  define XML_PARSE_UNZIP 0x1000000
#  define XML_PARSE_NO_SYS_CATALOG 0x2000000
#  define XML_PARSE_CATALOG_PI 0x4000000
#endif
#if LIBXML_VERSION < 21500
#  define XML_PARSE_SKIP_IDS 0x8000000
#endif

#include "libxml/tree.h"
#ifndef LIBXML2_NEW_BUFFER
   typedef xmlBuffer xmlBuf;
#  define xmlBufContent(buf) xmlBufferContent(buf)
#  define xmlBufUse(buf) xmlBufferLength(buf)
#endif

#if LIBXML_VERSION < 21500
#  define xmlCtxtIsStopped(p_ctxt)  ((p_ctxt)->disableSAX != 0)
#endif

/* libexslt 1.1.25+ support EXSLT functions in XPath */
#if LIBXSLT_VERSION < 10125
#define exsltDateXpathCtxtRegister(ctxt, prefix)
#define exsltSetsXpathCtxtRegister(ctxt, prefix)
#define exsltMathXpathCtxtRegister(ctxt, prefix)
#define exsltStrXpathCtxtRegister(ctxt, prefix)
#endif

#define LXML_GET_XSLT_ENCODING(result_var, style) XSLT_GET_IMPORT_PTR(result_var, style, encoding)

/* work around MSDEV 6.0 */
#if (_MSC_VER == 1200) && (WINVER < 0x0500)
long _ftol( double ); //defined by VC6 C libs
long _ftol2( double dblSource ) { return _ftol( dblSource ); }
#endif

#ifdef __GNUC__
/* Test for GCC > 2.95 */
#if __GNUC__ > 2 || (__GNUC__ == 2 && (__GNUC_MINOR__ > 95))
#define unlikely_condition(x) __builtin_expect((x), 0)
#else /* __GNUC__ > 2 ... */
#define unlikely_condition(x) (x)
#endif /* __GNUC__ > 2 ... */
#else /* __GNUC__ */
#define unlikely_condition(x) (x)
#endif /* __GNUC__ */

#ifndef Py_TYPE
  #define Py_TYPE(ob)   (((PyObject*)(ob))->ob_type)
#endif

#define _fqtypename(o)  ((Py_TYPE(o))->tp_name)

#define lxml_malloc(count, item_size) \
    (unlikely_condition((size_t)(count) > (size_t) (PY_SSIZE_T_MAX / item_size)) ? NULL : \
     (PyMem_Malloc((count) * item_size)))

#define lxml_realloc(mem, count, item_size) \
    (unlikely_condition((size_t)(count) > (size_t) (PY_SSIZE_T_MAX / item_size)) ? NULL : \
     (PyMem_Realloc(mem, (count) * item_size)))

#define lxml_free(mem)  PyMem_Free(mem)

#define _isString(obj)   (PyUnicode_Check(obj) || PyBytes_Check(obj))

#define _isElement(c_node) \
        (((c_node)->type == XML_ELEMENT_NODE) || \
         ((c_node)->type == XML_COMMENT_NODE) || \
         ((c_node)->type == XML_ENTITY_REF_NODE) || \
         ((c_node)->type == XML_PI_NODE))

#define _isElementOrXInclude(c_node) \
        (_isElement(c_node)                     || \
         ((c_node)->type == XML_XINCLUDE_START) || \
         ((c_node)->type == XML_XINCLUDE_END))

#define _getNs(c_node) \
        (((c_node)->ns == 0) ? 0 : ((c_node)->ns->href))


#include "string.h"
static void* lxml_unpack_xmldoc_capsule(PyObject* capsule, int* is_owned) {
    xmlDoc *c_doc;
    void *context;
    *is_owned = 0;
    if (unlikely_condition(!PyCapsule_IsValid(capsule, (const char*)"libxml2:xmlDoc"))) {
        PyErr_SetString(
                PyExc_TypeError,
                "Not a valid capsule. The capsule argument must be a capsule object with name libxml2:xmlDoc");
        return NULL;
    }
    c_doc = (xmlDoc*) PyCapsule_GetPointer(capsule, (const char*)"libxml2:xmlDoc");
    if (unlikely_condition(!c_doc)) return NULL;

    if (unlikely_condition(c_doc->type != XML_DOCUMENT_NODE && c_doc->type != XML_HTML_DOCUMENT_NODE)) {
        PyErr_Format(
            PyExc_ValueError,
            "Illegal document provided: expected XML or HTML, found %d", (int)c_doc->type);
        return NULL;
    }

    context = PyCapsule_GetContext(capsule);
    if (unlikely_condition(!context && PyErr_Occurred())) return NULL;
    if (context && strcmp((const char*) context, "destructor:xmlFreeDoc") == 0) {
        /* take ownership by setting destructor to NULL */
        if (PyCapsule_SetDestructor(capsule, NULL) == 0) {
            /* ownership transferred => invalidate capsule by clearing its name */
            if (unlikely_condition(PyCapsule_SetName(capsule, NULL))) {
                /* this should never happen since everything above succeeded */
                xmlFreeDoc(c_doc);
                return NULL;
            }
            *is_owned = 1;
        }
    }
    return c_doc;
}

/* Macro pair implementation of a depth first tree walker
 *
 * Calls the code block between the BEGIN and END macros for all elements
 * below c_tree_top (exclusively), starting at c_node (inclusively iff
 * 'inclusive' is 1).  The _ELEMENT_ variants will only stop on nodes
 * that match _isElement(), the normal variant will stop on every node
 * except text nodes.
 *
 * To traverse the node and all of its children and siblings in Pyrex, call
 *    cdef xmlNode* some_node
 *    BEGIN_FOR_EACH_ELEMENT_FROM(some_node.parent, some_node, 1)
 *    # do something with some_node
 *    END_FOR_EACH_ELEMENT_FROM(some_node)
 *
 * To traverse only the children and siblings of a node, call
 *    cdef xmlNode* some_node
 *    BEGIN_FOR_EACH_ELEMENT_FROM(some_node.parent, some_node, 0)
 *    # do something with some_node
 *    END_FOR_EACH_ELEMENT_FROM(some_node)
 *
 * To traverse only the children, do:
 *    cdef xmlNode* some_node
 *    some_node = parent_node.children
 *    BEGIN_FOR_EACH_ELEMENT_FROM(parent_node, some_node, 1)
 *    # do something with some_node
 *    END_FOR_EACH_ELEMENT_FROM(some_node)
 *
 * NOTE: 'some_node' MUST be a plain 'xmlNode*' !
 *
 * NOTE: parent modification during the walk can divert the iterator, but
 *       should not segfault !
 */

#define _LX__ELEMENT_MATCH(c_node, only_elements)  \
    ((only_elements) ? (_isElement(c_node)) : 1)

#define _LX__ADVANCE_TO_NEXT(c_node, only_elements)                        \
    while ((c_node != 0) && (!_LX__ELEMENT_MATCH(c_node, only_elements)))  \
        c_node = c_node->next;

#define _LX__TRAVERSE_TO_NEXT(c_stop_node, c_node, only_elements)   \
{                                                                   \
    /* walk through children first */                               \
    xmlNode* _lx__next = c_node->children;		            \
    if (_lx__next != 0) {                                           \
        if (c_node->type == XML_ENTITY_REF_NODE || c_node->type == XML_DTD_NODE) { \
            _lx__next = 0;                                          \
        } else {                                                    \
            _LX__ADVANCE_TO_NEXT(_lx__next, only_elements)	    \
        }                                                           \
    }							            \
    if ((_lx__next == 0) && (c_node != c_stop_node)) {              \
        /* try siblings */                                          \
        _lx__next = c_node->next;                                   \
        _LX__ADVANCE_TO_NEXT(_lx__next, only_elements)              \
        /* back off through parents */                              \
        while (_lx__next == 0) {                                    \
            c_node = c_node->parent;                                \
            if (c_node == 0)                                        \
                break;                                              \
            if (c_node == c_stop_node)                              \
                break;                                              \
            if ((only_elements) && !_isElement(c_node))	            \
                break;                                              \
            /* we already traversed the parents -> siblings */      \
            _lx__next = c_node->next;                               \
            _LX__ADVANCE_TO_NEXT(_lx__next, only_elements)	    \
        }                                                           \
    }                                                               \
    c_node = _lx__next;                                             \
}

#define _LX__BEGIN_FOR_EACH_FROM(c_tree_top, c_node, inclusive, only_elements)     \
{									      \
    if (c_node != 0) {							      \
        const xmlNode* _lx__tree_top = (c_tree_top);                          \
        const int _lx__only_elements = (only_elements);                       \
        /* make sure we start at an element */                   	      \
        if (!_LX__ELEMENT_MATCH(c_node, _lx__only_elements)) {		      \
            /* we skip the node, so 'inclusive' is irrelevant */              \
            if (c_node == _lx__tree_top)                                      \
                c_node = 0; /* nothing to traverse */                         \
            else {                                                            \
                c_node = c_node->next;                                        \
                _LX__ADVANCE_TO_NEXT(c_node, _lx__only_elements)              \
            }                                                                 \
        } else if (! (inclusive)) {                                           \
            /* skip the first node */                                         \
            _LX__TRAVERSE_TO_NEXT(_lx__tree_top, c_node, _lx__only_elements)  \
        }                                                                     \
                                                                              \
        /* now run the user code on the elements we find */                   \
        while (c_node != 0) {                                                 \
            /* here goes the code to be run for each element */

#define _LX__END_FOR_EACH_FROM(c_node)                                        \
            _LX__TRAVERSE_TO_NEXT(_lx__tree_top, c_node, _lx__only_elements)  \
        }                                                                     \
    }                                                                         \
}


#define BEGIN_FOR_EACH_ELEMENT_FROM(c_tree_top, c_node, inclusive)   \
    _LX__BEGIN_FOR_EACH_FROM(c_tree_top, c_node, inclusive, 1)

#define END_FOR_EACH_ELEMENT_FROM(c_node)   \
    _LX__END_FOR_EACH_FROM(c_node)

#define BEGIN_FOR_EACH_FROM(c_tree_top, c_node, inclusive)   \
    _LX__BEGIN_FOR_EACH_FROM(c_tree_top, c_node, inclusive, 0)

#define END_FOR_EACH_FROM(c_node)   \
    _LX__END_FOR_EACH_FROM(c_node)


#endif /* HAS_ETREE_DEFS_H */
