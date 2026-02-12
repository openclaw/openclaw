/*
 * Summary: Locale handling
 * Description: Interfaces for locale handling. Needed for language dependent
 *              sorting.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Nick Wellnhofer
 */

#ifndef __XML_XSLTLOCALE_H__
#define __XML_XSLTLOCALE_H__

#include <libxml/xmlstring.h>
#include "xsltexports.h"

#ifdef __cplusplus
extern "C" {
#endif

XSLTPUBFUN void * XSLTCALL
	xsltNewLocale			(const xmlChar *langName,
					 int lowerFirst);
XSLTPUBFUN void XSLTCALL
	xsltFreeLocale			(void *locale);
XSLTPUBFUN xmlChar * XSLTCALL
	xsltStrxfrm			(void *locale,
					 const xmlChar *string);
XSLTPUBFUN void XSLTCALL
	xsltFreeLocales			(void);

/* Backward compatibility */
typedef void *xsltLocale;
typedef xmlChar xsltLocaleChar;
XSLTPUBFUN int XSLTCALL
	xsltLocaleStrcmp		(void *locale,
					 const xmlChar *str1,
					 const xmlChar *str2);

#ifdef __cplusplus
}
#endif

#endif /* __XML_XSLTLOCALE_H__ */
