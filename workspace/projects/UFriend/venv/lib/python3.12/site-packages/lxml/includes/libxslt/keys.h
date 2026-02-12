/*
 * Summary:  interface for the key matching used in key() and template matches.
 * Description: implementation of the key mechanims.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XSLT_KEY_H__
#define __XML_XSLT_KEY_H__

#include <libxml/xpath.h>
#include "xsltexports.h"
#include "xsltInternals.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * NODE_IS_KEYED:
 *
 * check for bit 15 set
 */
#define NODE_IS_KEYED (1 >> 15)

XSLTPUBFUN int XSLTCALL
		xsltAddKey		(xsltStylesheetPtr style,
					 const xmlChar *name,
					 const xmlChar *nameURI,
					 const xmlChar *match,
					 const xmlChar *use,
					 xmlNodePtr inst);
XSLTPUBFUN xmlNodeSetPtr XSLTCALL
		xsltGetKey		(xsltTransformContextPtr ctxt,
					 const xmlChar *name,
					 const xmlChar *nameURI,
					 const xmlChar *value);
XSLTPUBFUN void XSLTCALL
		xsltInitCtxtKeys	(xsltTransformContextPtr ctxt,
					 xsltDocumentPtr doc);
XSLTPUBFUN void XSLTCALL
		xsltFreeKeys		(xsltStylesheetPtr style);
XSLTPUBFUN void XSLTCALL
		xsltFreeDocumentKeys	(xsltDocumentPtr doc);

#ifdef __cplusplus
}
#endif

#endif /* __XML_XSLT_H__ */

