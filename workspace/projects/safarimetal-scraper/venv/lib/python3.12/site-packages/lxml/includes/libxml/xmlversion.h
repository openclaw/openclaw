/*
 * Summary: compile-time version information
 * Description: compile-time version information for the XML library
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_VERSION_H__
#define __XML_VERSION_H__

/**
 * LIBXML_DOTTED_VERSION:
 *
 * the version string like "1.2.3"
 */
#define LIBXML_DOTTED_VERSION "2.14.6"

/**
 * LIBXML_VERSION:
 *
 * the version number: 1.2.3 value is 10203
 */
#define LIBXML_VERSION 21406

/**
 * LIBXML_VERSION_STRING:
 *
 * the version number string, 1.2.3 value is "10203"
 */
#define LIBXML_VERSION_STRING "21406"

/**
 * LIBXML_VERSION_EXTRA:
 *
 * extra version information, used to show a git commit description
 */
#define LIBXML_VERSION_EXTRA ""

/**
 * LIBXML_TEST_VERSION:
 *
 * Macro to check that the libxml version in use is compatible with
 * the version the software has been compiled against
 */
#define LIBXML_TEST_VERSION xmlCheckVersion(21406);

/**
 * LIBXML_THREAD_ENABLED:
 *
 * Whether the thread support is configured in
 */
#if 1
#define LIBXML_THREAD_ENABLED
#endif

/**
 * LIBXML_THREAD_ALLOC_ENABLED:
 *
 * Whether the allocation hooks are per-thread
 */
#if 0
#define LIBXML_THREAD_ALLOC_ENABLED
#endif

/**
 * LIBXML_TREE_ENABLED:
 *
 * Always enabled since 2.14.0
 */
#define LIBXML_TREE_ENABLED

/**
 * LIBXML_OUTPUT_ENABLED:
 *
 * Whether the serialization/saving support is configured in
 */
#if 1
#define LIBXML_OUTPUT_ENABLED
#endif

/**
 * LIBXML_PUSH_ENABLED:
 *
 * Whether the push parsing interfaces are configured in
 */
#if 1
#define LIBXML_PUSH_ENABLED
#endif

/**
 * LIBXML_READER_ENABLED:
 *
 * Whether the xmlReader parsing interface is configured in
 */
#if 1
#define LIBXML_READER_ENABLED
#endif

/**
 * LIBXML_PATTERN_ENABLED:
 *
 * Whether the xmlPattern node selection interface is configured in
 */
#if 1
#define LIBXML_PATTERN_ENABLED
#endif

/**
 * LIBXML_WRITER_ENABLED:
 *
 * Whether the xmlWriter saving interface is configured in
 */
#if 1
#define LIBXML_WRITER_ENABLED
#endif

/**
 * LIBXML_SAX1_ENABLED:
 *
 * Whether the older SAX1 interface is configured in
 */
#if 1
#define LIBXML_SAX1_ENABLED
#endif

/**
 * LIBXML_HTTP_ENABLED:
 *
 * Whether the HTTP support is configured in
 */
#if 0
#define LIBXML_HTTP_ENABLED
#endif

/**
 * LIBXML_VALID_ENABLED:
 *
 * Whether the DTD validation support is configured in
 */
#if 1
#define LIBXML_VALID_ENABLED
#endif

/**
 * LIBXML_HTML_ENABLED:
 *
 * Whether the HTML support is configured in
 */
#if 1
#define LIBXML_HTML_ENABLED
#endif

/**
 * LIBXML_LEGACY_ENABLED:
 *
 * Removed in 2.14
 */
#undef LIBXML_LEGACY_ENABLED

/**
 * LIBXML_C14N_ENABLED:
 *
 * Whether the Canonicalization support is configured in
 */
#if 1
#define LIBXML_C14N_ENABLED
#endif

/**
 * LIBXML_CATALOG_ENABLED:
 *
 * Whether the Catalog support is configured in
 */
#if 1
#define LIBXML_CATALOG_ENABLED
#endif

/**
 * LIBXML_XPATH_ENABLED:
 *
 * Whether XPath is configured in
 */
#if 1
#define LIBXML_XPATH_ENABLED
#endif

/**
 * LIBXML_XPTR_ENABLED:
 *
 * Whether XPointer is configured in
 */
#if 1
#define LIBXML_XPTR_ENABLED
#endif

/**
 * LIBXML_XINCLUDE_ENABLED:
 *
 * Whether XInclude is configured in
 */
#if 1
#define LIBXML_XINCLUDE_ENABLED
#endif

/**
 * LIBXML_ICONV_ENABLED:
 *
 * Whether iconv support is available
 */
#if 1
#define LIBXML_ICONV_ENABLED
#endif

/**
 * LIBXML_ICU_ENABLED:
 *
 * Whether icu support is available
 */
#if 0
#define LIBXML_ICU_ENABLED
#endif

/**
 * LIBXML_ISO8859X_ENABLED:
 *
 * Whether ISO-8859-* support is made available in case iconv is not
 */
#if 1
#define LIBXML_ISO8859X_ENABLED
#endif

/**
 * LIBXML_DEBUG_ENABLED:
 *
 * Whether Debugging module is configured in
 */
#if 1
#define LIBXML_DEBUG_ENABLED
#endif

/**
 * LIBXML_UNICODE_ENABLED:
 *
 * Removed in 2.14
 */
#undef LIBXML_UNICODE_ENABLED

/**
 * LIBXML_REGEXP_ENABLED:
 *
 * Whether the regular expressions interfaces are compiled in
 */
#if 1
#define LIBXML_REGEXP_ENABLED
#endif

/**
 * LIBXML_AUTOMATA_ENABLED:
 *
 * Whether the automata interfaces are compiled in
 */
#if 1
#define LIBXML_AUTOMATA_ENABLED
#endif

/**
 * LIBXML_RELAXNG_ENABLED:
 *
 * Whether the RelaxNG validation interfaces are compiled in
 */
#if 1
#define LIBXML_RELAXNG_ENABLED
#endif

/**
 * LIBXML_SCHEMAS_ENABLED:
 *
 * Whether the Schemas validation interfaces are compiled in
 */
#if 1
#define LIBXML_SCHEMAS_ENABLED
#endif

/**
 * LIBXML_SCHEMATRON_ENABLED:
 *
 * Whether the Schematron validation interfaces are compiled in
 */
#if 1
#define LIBXML_SCHEMATRON_ENABLED
#endif

/**
 * LIBXML_MODULES_ENABLED:
 *
 * Whether the module interfaces are compiled in
 */
#if 1
#define LIBXML_MODULES_ENABLED
/**
 * LIBXML_MODULE_EXTENSION:
 *
 * the string suffix used by dynamic modules (usually shared libraries)
 */
#define LIBXML_MODULE_EXTENSION ".so" 
#endif

/**
 * LIBXML_ZLIB_ENABLED:
 *
 * Whether the Zlib support is compiled in
 */
#if 1
#define LIBXML_ZLIB_ENABLED
#endif

/**
 * LIBXML_LZMA_ENABLED:
 *
 * Whether the Lzma support is compiled in
 */
#if 0
#define LIBXML_LZMA_ENABLED
#endif

#include <libxml/xmlexports.h>

#endif


