/*
 * Summary: main header file
 *
 * Copy: See Copyright for the status of this software.
 */


#ifndef __EXSLT_H__
#define __EXSLT_H__

#include <libxml/tree.h>
#include <libxml/xpath.h>
#include "exsltexports.h"
#include <libexslt/exsltconfig.h>

#ifdef __cplusplus
extern "C" {
#endif

EXSLTPUBVAR const char *exsltLibraryVersion;
EXSLTPUBVAR const int exsltLibexsltVersion;
EXSLTPUBVAR const int exsltLibxsltVersion;
EXSLTPUBVAR const int exsltLibxmlVersion;

/**
 * EXSLT_COMMON_NAMESPACE:
 *
 * Namespace for EXSLT common functions
 */
#define EXSLT_COMMON_NAMESPACE ((const xmlChar *) "http://exslt.org/common")
/**
 * EXSLT_CRYPTO_NAMESPACE:
 *
 * Namespace for EXSLT crypto functions
 */
#define EXSLT_CRYPTO_NAMESPACE ((const xmlChar *) "http://exslt.org/crypto")
/**
 * EXSLT_MATH_NAMESPACE:
 *
 * Namespace for EXSLT math functions
 */
#define EXSLT_MATH_NAMESPACE ((const xmlChar *) "http://exslt.org/math")
/**
 * EXSLT_SETS_NAMESPACE:
 *
 * Namespace for EXSLT set functions
 */
#define EXSLT_SETS_NAMESPACE ((const xmlChar *) "http://exslt.org/sets")
/**
 * EXSLT_FUNCTIONS_NAMESPACE:
 *
 * Namespace for EXSLT functions extension functions
 */
#define EXSLT_FUNCTIONS_NAMESPACE ((const xmlChar *) "http://exslt.org/functions")
/**
 * EXSLT_STRINGS_NAMESPACE:
 *
 * Namespace for EXSLT strings functions
 */
#define EXSLT_STRINGS_NAMESPACE ((const xmlChar *) "http://exslt.org/strings")
/**
 * EXSLT_DATE_NAMESPACE:
 *
 * Namespace for EXSLT date functions
 */
#define EXSLT_DATE_NAMESPACE ((const xmlChar *) "http://exslt.org/dates-and-times")
/**
 * EXSLT_DYNAMIC_NAMESPACE:
 *
 * Namespace for EXSLT dynamic functions
 */
#define EXSLT_DYNAMIC_NAMESPACE ((const xmlChar *) "http://exslt.org/dynamic")

/**
 * SAXON_NAMESPACE:
 *
 * Namespace for SAXON extensions functions
 */
#define SAXON_NAMESPACE ((const xmlChar *) "http://icl.com/saxon")

EXSLTPUBFUN void EXSLTCALL exsltCommonRegister (void);
#ifdef EXSLT_CRYPTO_ENABLED
EXSLTPUBFUN void EXSLTCALL exsltCryptoRegister (void);
#endif
EXSLTPUBFUN void EXSLTCALL exsltMathRegister (void);
EXSLTPUBFUN void EXSLTCALL exsltSetsRegister (void);
EXSLTPUBFUN void EXSLTCALL exsltFuncRegister (void);
EXSLTPUBFUN void EXSLTCALL exsltStrRegister (void);
EXSLTPUBFUN void EXSLTCALL exsltDateRegister (void);
EXSLTPUBFUN void EXSLTCALL exsltSaxonRegister (void);
EXSLTPUBFUN void EXSLTCALL exsltDynRegister(void);

EXSLTPUBFUN void EXSLTCALL exsltRegisterAll (void);

EXSLTPUBFUN int EXSLTCALL exsltDateXpathCtxtRegister (xmlXPathContextPtr ctxt,
                                                      const xmlChar *prefix);
EXSLTPUBFUN int EXSLTCALL exsltMathXpathCtxtRegister (xmlXPathContextPtr ctxt,
                                                      const xmlChar *prefix);
EXSLTPUBFUN int EXSLTCALL exsltSetsXpathCtxtRegister (xmlXPathContextPtr ctxt,
                                                      const xmlChar *prefix);
EXSLTPUBFUN int EXSLTCALL exsltStrXpathCtxtRegister (xmlXPathContextPtr ctxt,
                                                     const xmlChar *prefix);

#ifdef __cplusplus
}
#endif
#endif /* __EXSLT_H__ */

