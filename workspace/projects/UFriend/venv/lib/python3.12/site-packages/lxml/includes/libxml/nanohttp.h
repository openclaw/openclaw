/*
 * Summary: minimal HTTP implementation
 * Description: minimal HTTP implementation allowing to fetch resources
 *              like external subset.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __NANO_HTTP_H__
#define __NANO_HTTP_H__

#include <libxml/xmlversion.h>

#ifdef LIBXML_HTTP_ENABLED

#ifdef __cplusplus
extern "C" {
#endif
XML_DEPRECATED
XMLPUBFUN void
	xmlNanoHTTPInit		(void);
XML_DEPRECATED
XMLPUBFUN void
	xmlNanoHTTPCleanup	(void);
XML_DEPRECATED
XMLPUBFUN void
	xmlNanoHTTPScanProxy	(const char *URL);
XML_DEPRECATED
XMLPUBFUN int
	xmlNanoHTTPFetch	(const char *URL,
				 const char *filename,
				 char **contentType);
XML_DEPRECATED
XMLPUBFUN void *
	xmlNanoHTTPMethod	(const char *URL,
				 const char *method,
				 const char *input,
				 char **contentType,
				 const char *headers,
				 int   ilen);
XML_DEPRECATED
XMLPUBFUN void *
	xmlNanoHTTPMethodRedir	(const char *URL,
				 const char *method,
				 const char *input,
				 char **contentType,
				 char **redir,
				 const char *headers,
				 int   ilen);
XML_DEPRECATED
XMLPUBFUN void *
	xmlNanoHTTPOpen		(const char *URL,
				 char **contentType);
XML_DEPRECATED
XMLPUBFUN void *
	xmlNanoHTTPOpenRedir	(const char *URL,
				 char **contentType,
				 char **redir);
XML_DEPRECATED
XMLPUBFUN int
	xmlNanoHTTPReturnCode	(void *ctx);
XML_DEPRECATED
XMLPUBFUN const char *
	xmlNanoHTTPAuthHeader	(void *ctx);
XML_DEPRECATED
XMLPUBFUN const char *
	xmlNanoHTTPRedir	(void *ctx);
XML_DEPRECATED
XMLPUBFUN int
	xmlNanoHTTPContentLength( void * ctx );
XML_DEPRECATED
XMLPUBFUN const char *
	xmlNanoHTTPEncoding	(void *ctx);
XML_DEPRECATED
XMLPUBFUN const char *
	xmlNanoHTTPMimeType	(void *ctx);
XML_DEPRECATED
XMLPUBFUN int
	xmlNanoHTTPRead		(void *ctx,
				 void *dest,
				 int len);
#ifdef LIBXML_OUTPUT_ENABLED
XML_DEPRECATED
XMLPUBFUN int
	xmlNanoHTTPSave		(void *ctxt,
				 const char *filename);
#endif /* LIBXML_OUTPUT_ENABLED */
XML_DEPRECATED
XMLPUBFUN void
	xmlNanoHTTPClose	(void *ctx);
#ifdef __cplusplus
}
#endif

#endif /* LIBXML_HTTP_ENABLED */
#endif /* __NANO_HTTP_H__ */
