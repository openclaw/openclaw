/*
 * Summary: the XSLT engine transformation part.
 * Description: This module implements the bulk of the actual
 *              transformation processing. Most of the xsl: element
 *              constructs are implemented in this module.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XSLT_TRANSFORM_H__
#define __XML_XSLT_TRANSFORM_H__

#include <libxml/parser.h>
#include <libxml/xmlIO.h>
#include "xsltexports.h"
#include <libxslt/xsltInternals.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * XInclude default processing.
 */
XSLTPUBFUN void XSLTCALL
		xsltSetXIncludeDefault	(int xinclude);
XSLTPUBFUN int XSLTCALL
		xsltGetXIncludeDefault	(void);

/**
 * Export context to users.
 */
XSLTPUBFUN xsltTransformContextPtr XSLTCALL
		xsltNewTransformContext	(xsltStylesheetPtr style,
					 xmlDocPtr doc);

XSLTPUBFUN void XSLTCALL
		xsltFreeTransformContext(xsltTransformContextPtr ctxt);

XSLTPUBFUN xmlDocPtr XSLTCALL
		xsltApplyStylesheetUser	(xsltStylesheetPtr style,
					 xmlDocPtr doc,
					 const char **params,
					 const char *output,
					 FILE * profile,
					 xsltTransformContextPtr userCtxt);
XSLTPUBFUN void XSLTCALL
                xsltProcessOneNode      (xsltTransformContextPtr ctxt,
                                         xmlNodePtr node,
                                         xsltStackElemPtr params);
/**
 * Private Interfaces.
 */
XSLTPUBFUN void XSLTCALL
		xsltApplyStripSpaces	(xsltTransformContextPtr ctxt,
					 xmlNodePtr node);
XSLTPUBFUN xmlDocPtr XSLTCALL
		xsltApplyStylesheet	(xsltStylesheetPtr style,
					 xmlDocPtr doc,
					 const char **params);
XSLTPUBFUN xmlDocPtr XSLTCALL
		xsltProfileStylesheet	(xsltStylesheetPtr style,
					 xmlDocPtr doc,
					 const char **params,
					 FILE * output);
XSLTPUBFUN int XSLTCALL
		xsltRunStylesheet	(xsltStylesheetPtr style,
					 xmlDocPtr doc,
					 const char **params,
					 const char *output,
					 xmlSAXHandlerPtr SAX,
					 xmlOutputBufferPtr IObuf);
XSLTPUBFUN int XSLTCALL
		xsltRunStylesheetUser	(xsltStylesheetPtr style,
					 xmlDocPtr doc,
					 const char **params,
					 const char *output,
					 xmlSAXHandlerPtr SAX,
					 xmlOutputBufferPtr IObuf,
					 FILE * profile,
					 xsltTransformContextPtr userCtxt);
XSLTPUBFUN void XSLTCALL
		xsltApplyOneTemplate	(xsltTransformContextPtr ctxt,
					 xmlNodePtr node,
					 xmlNodePtr list,
					 xsltTemplatePtr templ,
					 xsltStackElemPtr params);
XSLTPUBFUN void XSLTCALL
		xsltDocumentElem	(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltSort		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltCopy		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltText		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltElement		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltComment		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltAttribute		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltProcessingInstruction(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltCopyOf		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltValueOf		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltNumber		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltApplyImports	(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltCallTemplate	(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltApplyTemplates	(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltChoose		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltIf			(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltForEach		(xsltTransformContextPtr ctxt,
	                                 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);
XSLTPUBFUN void XSLTCALL
		xsltRegisterAllElement	(xsltTransformContextPtr ctxt);

XSLTPUBFUN xmlNodePtr XSLTCALL
		xsltCopyTextString	(xsltTransformContextPtr ctxt,
					 xmlNodePtr target,
					 const xmlChar *string,
					 int noescape);

/* Following 2 functions needed for libexslt/functions.c */
XSLTPUBFUN void XSLTCALL
		xsltLocalVariablePop	(xsltTransformContextPtr ctxt,
					 int limitNr,
					 int level);
XSLTPUBFUN int XSLTCALL
		xsltLocalVariablePush	(xsltTransformContextPtr ctxt,
					 xsltStackElemPtr variable,
					 int level);
/*
 * Hook for the debugger if activated.
 */
XSLTPUBFUN void XSLTCALL
		xslHandleDebugger	(xmlNodePtr cur,
					 xmlNodePtr node,
					 xsltTemplatePtr templ,
					 xsltTransformContextPtr ctxt);

#ifdef __cplusplus
}
#endif

#endif /* __XML_XSLT_TRANSFORM_H__ */

