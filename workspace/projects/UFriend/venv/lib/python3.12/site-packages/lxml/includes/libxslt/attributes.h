/*
 * Summary: interface for the XSLT attribute handling
 * Description: this module handles the specificities of attribute
 *              and attribute groups processing.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XSLT_ATTRIBUTES_H__
#define __XML_XSLT_ATTRIBUTES_H__

#include <libxml/tree.h>
#include "xsltexports.h"
#include "xsltInternals.h"

#ifdef __cplusplus
extern "C" {
#endif

XSLTPUBFUN void XSLTCALL
	xsltParseStylesheetAttributeSet	(xsltStylesheetPtr style,
					 xmlNodePtr cur);
XSLTPUBFUN void XSLTCALL
	xsltFreeAttributeSetsHashes	(xsltStylesheetPtr style);
XSLTPUBFUN void XSLTCALL
	xsltApplyAttributeSet		(xsltTransformContextPtr ctxt,
					 xmlNodePtr node,
					 xmlNodePtr inst,
					 const xmlChar *attributes);
XSLTPUBFUN void XSLTCALL
	xsltResolveStylesheetAttributeSet(xsltStylesheetPtr style);
#ifdef __cplusplus
}
#endif

#endif /* __XML_XSLT_ATTRIBUTES_H__ */

