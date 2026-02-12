/*
 * Summary: interface for the non-standard features
 * Description: implement some extension outside the XSLT namespace
 *              but not EXSLT with is in a different library.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XSLT_EXTRA_H__
#define __XML_XSLT_EXTRA_H__

#include <libxml/xpath.h>
#include "xsltexports.h"
#include "xsltInternals.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * XSLT_LIBXSLT_NAMESPACE:
 *
 * This is the libxslt namespace for specific extensions.
 */
#define XSLT_LIBXSLT_NAMESPACE ((xmlChar *) "http://xmlsoft.org/XSLT/namespace")

/**
 * XSLT_SAXON_NAMESPACE:
 *
 * This is Michael Kay's Saxon processor namespace for extensions.
 */
#define XSLT_SAXON_NAMESPACE ((xmlChar *) "http://icl.com/saxon")

/**
 * XSLT_XT_NAMESPACE:
 *
 * This is James Clark's XT processor namespace for extensions.
 */
#define XSLT_XT_NAMESPACE ((xmlChar *) "http://www.jclark.com/xt")

/**
 * XSLT_XALAN_NAMESPACE:
 *
 * This is the Apache project XALAN processor namespace for extensions.
 */
#define XSLT_XALAN_NAMESPACE ((xmlChar *)	\
	                        "org.apache.xalan.xslt.extensions.Redirect")


XSLTPUBFUN void XSLTCALL
		xsltFunctionNodeSet	(xmlXPathParserContextPtr ctxt,
					 int nargs);
XSLTPUBFUN void XSLTCALL
		xsltDebug		(xsltTransformContextPtr ctxt,
					 xmlNodePtr node,
					 xmlNodePtr inst,
					 xsltElemPreCompPtr comp);


XSLTPUBFUN void XSLTCALL
		xsltRegisterExtras	(xsltTransformContextPtr ctxt);
XSLTPUBFUN void XSLTCALL
		xsltRegisterAllExtras	(void);

#ifdef __cplusplus
}
#endif

#endif /* __XML_XSLT_EXTRA_H__ */

