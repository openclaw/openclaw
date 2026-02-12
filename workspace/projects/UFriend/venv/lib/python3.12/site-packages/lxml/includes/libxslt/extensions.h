/*
 * Summary: interface for the extension support
 * Description: This provide the API needed for simple and module
 *              extension support.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XSLT_EXTENSION_H__
#define __XML_XSLT_EXTENSION_H__

#include <libxml/xpath.h>
#include "xsltexports.h"
#include "xsltInternals.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Extension Modules API.
 */

/**
 * xsltInitGlobals:
 *
 * Initialize the global variables for extensions
 *
 */

XSLTPUBFUN void XSLTCALL
		xsltInitGlobals                 (void);

/**
 * xsltStyleExtInitFunction:
 * @ctxt:  an XSLT stylesheet
 * @URI:  the namespace URI for the extension
 *
 * A function called at initialization time of an XSLT extension module.
 *
 * Returns a pointer to the module specific data for this transformation.
 */
typedef void * (*xsltStyleExtInitFunction)	(xsltStylesheetPtr style,
						 const xmlChar *URI);

/**
 * xsltStyleExtShutdownFunction:
 * @ctxt:  an XSLT stylesheet
 * @URI:  the namespace URI for the extension
 * @data:  the data associated to this module
 *
 * A function called at shutdown time of an XSLT extension module.
 */
typedef void (*xsltStyleExtShutdownFunction)	(xsltStylesheetPtr style,
						 const xmlChar *URI,
						 void *data);

/**
 * xsltExtInitFunction:
 * @ctxt:  an XSLT transformation context
 * @URI:  the namespace URI for the extension
 *
 * A function called at initialization time of an XSLT extension module.
 *
 * Returns a pointer to the module specific data for this transformation.
 */
typedef void * (*xsltExtInitFunction)	(xsltTransformContextPtr ctxt,
					 const xmlChar *URI);

/**
 * xsltExtShutdownFunction:
 * @ctxt:  an XSLT transformation context
 * @URI:  the namespace URI for the extension
 * @data:  the data associated to this module
 *
 * A function called at shutdown time of an XSLT extension module.
 */
typedef void (*xsltExtShutdownFunction) (xsltTransformContextPtr ctxt,
					 const xmlChar *URI,
					 void *data);

XSLTPUBFUN int XSLTCALL
		xsltRegisterExtModule	(const xmlChar *URI,
					 xsltExtInitFunction initFunc,
					 xsltExtShutdownFunction shutdownFunc);
XSLTPUBFUN int XSLTCALL
		xsltRegisterExtModuleFull
					(const xmlChar * URI,
					 xsltExtInitFunction initFunc,
					 xsltExtShutdownFunction shutdownFunc,
					 xsltStyleExtInitFunction styleInitFunc,
					 xsltStyleExtShutdownFunction styleShutdownFunc);

XSLTPUBFUN int XSLTCALL
		xsltUnregisterExtModule	(const xmlChar * URI);

XSLTPUBFUN void * XSLTCALL
		xsltGetExtData		(xsltTransformContextPtr ctxt,
					 const xmlChar *URI);

XSLTPUBFUN void * XSLTCALL
		xsltStyleGetExtData	(xsltStylesheetPtr style,
					 const xmlChar *URI);
#ifdef XSLT_REFACTORED
XSLTPUBFUN void * XSLTCALL
		xsltStyleStylesheetLevelGetExtData(
					 xsltStylesheetPtr style,
					 const xmlChar * URI);
#endif
XSLTPUBFUN void XSLTCALL
		xsltShutdownCtxtExts	(xsltTransformContextPtr ctxt);

XSLTPUBFUN void XSLTCALL
		xsltShutdownExts	(xsltStylesheetPtr style);

XSLTPUBFUN xsltTransformContextPtr XSLTCALL
		xsltXPathGetTransformContext
					(xmlXPathParserContextPtr ctxt);

/*
 * extension functions
*/
XSLTPUBFUN int XSLTCALL
		xsltRegisterExtModuleFunction
					(const xmlChar *name,
					 const xmlChar *URI,
					 xmlXPathFunction function);
XSLTPUBFUN xmlXPathFunction XSLTCALL
	xsltExtModuleFunctionLookup	(const xmlChar *name,
					 const xmlChar *URI);
XSLTPUBFUN int XSLTCALL
		xsltUnregisterExtModuleFunction
					(const xmlChar *name,
					 const xmlChar *URI);

/*
 * extension elements
 */
typedef xsltElemPreCompPtr (*xsltPreComputeFunction)
					(xsltStylesheetPtr style,
					 xmlNodePtr inst,
					 xsltTransformFunction function);

XSLTPUBFUN xsltElemPreCompPtr XSLTCALL
		xsltNewElemPreComp	(xsltStylesheetPtr style,
					 xmlNodePtr inst,
					 xsltTransformFunction function);
XSLTPUBFUN void XSLTCALL
		xsltInitElemPreComp	(xsltElemPreCompPtr comp,
					 xsltStylesheetPtr style,
					 xmlNodePtr inst,
					 xsltTransformFunction function,
					 xsltElemPreCompDeallocator freeFunc);

XSLTPUBFUN int XSLTCALL
		xsltRegisterExtModuleElement
					(const xmlChar *name,
					 const xmlChar *URI,
					 xsltPreComputeFunction precomp,
					 xsltTransformFunction transform);
XSLTPUBFUN xsltTransformFunction XSLTCALL
		xsltExtElementLookup	(xsltTransformContextPtr ctxt,
					 const xmlChar *name,
					 const xmlChar *URI);
XSLTPUBFUN xsltTransformFunction XSLTCALL
		xsltExtModuleElementLookup
					(const xmlChar *name,
					 const xmlChar *URI);
XSLTPUBFUN xsltPreComputeFunction XSLTCALL
		xsltExtModuleElementPreComputeLookup
					(const xmlChar *name,
					 const xmlChar *URI);
XSLTPUBFUN int XSLTCALL
		xsltUnregisterExtModuleElement
					(const xmlChar *name,
					 const xmlChar *URI);

/*
 * top-level elements
 */
typedef void (*xsltTopLevelFunction)	(xsltStylesheetPtr style,
					 xmlNodePtr inst);

XSLTPUBFUN int XSLTCALL
		xsltRegisterExtModuleTopLevel
					(const xmlChar *name,
					 const xmlChar *URI,
					 xsltTopLevelFunction function);
XSLTPUBFUN xsltTopLevelFunction XSLTCALL
		xsltExtModuleTopLevelLookup
					(const xmlChar *name,
					 const xmlChar *URI);
XSLTPUBFUN int XSLTCALL
		xsltUnregisterExtModuleTopLevel
					(const xmlChar *name,
					 const xmlChar *URI);


/* These 2 functions are deprecated for use within modules. */
XSLTPUBFUN int XSLTCALL
		xsltRegisterExtFunction	(xsltTransformContextPtr ctxt,
					 const xmlChar *name,
					 const xmlChar *URI,
					 xmlXPathFunction function);
XSLTPUBFUN int XSLTCALL
		xsltRegisterExtElement	(xsltTransformContextPtr ctxt,
					 const xmlChar *name,
					 const xmlChar *URI,
					 xsltTransformFunction function);

/*
 * Extension Prefix handling API.
 * Those are used by the XSLT (pre)processor.
 */

XSLTPUBFUN int XSLTCALL
		xsltRegisterExtPrefix	(xsltStylesheetPtr style,
					 const xmlChar *prefix,
					 const xmlChar *URI);
XSLTPUBFUN int XSLTCALL
		xsltCheckExtPrefix	(xsltStylesheetPtr style,
					 const xmlChar *URI);
XSLTPUBFUN int XSLTCALL
		xsltCheckExtURI		(xsltStylesheetPtr style,
					 const xmlChar *URI);
XSLTPUBFUN int XSLTCALL
		xsltInitCtxtExts	(xsltTransformContextPtr ctxt);
XSLTPUBFUN void XSLTCALL
		xsltFreeCtxtExts	(xsltTransformContextPtr ctxt);
XSLTPUBFUN void XSLTCALL
		xsltFreeExts		(xsltStylesheetPtr style);

XSLTPUBFUN xsltElemPreCompPtr XSLTCALL
		xsltPreComputeExtModuleElement
					(xsltStylesheetPtr style,
					 xmlNodePtr inst);
/*
 * Extension Infos access.
 * Used by exslt initialisation
 */

XSLTPUBFUN xmlHashTablePtr XSLTCALL
		xsltGetExtInfo		(xsltStylesheetPtr style,
					 const xmlChar *URI);

/**
 * Test of the extension module API
 */
XSLTPUBFUN void XSLTCALL
		xsltRegisterTestModule	(void);
XSLTPUBFUN void XSLTCALL
		xsltDebugDumpExtensions	(FILE * output);


#ifdef __cplusplus
}
#endif

#endif /* __XML_XSLT_EXTENSION_H__ */

