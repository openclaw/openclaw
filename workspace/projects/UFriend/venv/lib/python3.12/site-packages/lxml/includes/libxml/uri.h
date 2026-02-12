/**
 * Summary: library of generic URI related routines
 * Description: library of generic URI related routines
 *              Implements RFC 2396
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_URI_H__
#define __XML_URI_H__

#include <stdio.h>
#include <libxml/xmlversion.h>
#include <libxml/xmlstring.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * xmlURI:
 *
 * A parsed URI reference. This is a struct containing the various fields
 * as described in RFC 2396 but separated for further processing.
 *
 * Note: query is a deprecated field which is incorrectly unescaped.
 * query_raw takes precedence over query if the former is set.
 * See: http://mail.gnome.org/archives/xml/2007-April/thread.html#00127
 */
typedef struct _xmlURI xmlURI;
typedef xmlURI *xmlURIPtr;
struct _xmlURI {
    char *scheme;	/* the URI scheme */
    char *opaque;	/* opaque part */
    char *authority;	/* the authority part */
    char *server;	/* the server part */
    char *user;		/* the user part */
    int port;		/* the port number */
    char *path;		/* the path string */
    char *query;	/* the query string (deprecated - use with caution) */
    char *fragment;	/* the fragment identifier */
    int  cleanup;	/* parsing potentially unclean URI */
    char *query_raw;	/* the query string (as it appears in the URI) */
};

/*
 * This function is in tree.h:
 * xmlChar *	xmlNodeGetBase	(xmlDocPtr doc,
 *                               xmlNodePtr cur);
 */
XMLPUBFUN xmlURIPtr
		xmlCreateURI		(void);
XMLPUBFUN int
		xmlBuildURISafe		(const xmlChar *URI,
					 const xmlChar *base,
					 xmlChar **out);
XMLPUBFUN xmlChar *
		xmlBuildURI		(const xmlChar *URI,
					 const xmlChar *base);
XMLPUBFUN int
		xmlBuildRelativeURISafe	(const xmlChar *URI,
					 const xmlChar *base,
					 xmlChar **out);
XMLPUBFUN xmlChar *
		xmlBuildRelativeURI	(const xmlChar *URI,
					 const xmlChar *base);
XMLPUBFUN xmlURIPtr
		xmlParseURI		(const char *str);
XMLPUBFUN int
		xmlParseURISafe		(const char *str,
					 xmlURIPtr *uri);
XMLPUBFUN xmlURIPtr
		xmlParseURIRaw		(const char *str,
					 int raw);
XMLPUBFUN int
		xmlParseURIReference	(xmlURIPtr uri,
					 const char *str);
XMLPUBFUN xmlChar *
		xmlSaveUri		(xmlURIPtr uri);
XMLPUBFUN void
		xmlPrintURI		(FILE *stream,
					 xmlURIPtr uri);
XMLPUBFUN xmlChar *
		xmlURIEscapeStr         (const xmlChar *str,
					 const xmlChar *list);
XMLPUBFUN char *
		xmlURIUnescapeString	(const char *str,
					 int len,
					 char *target);
XMLPUBFUN int
		xmlNormalizeURIPath	(char *path);
XMLPUBFUN xmlChar *
		xmlURIEscape		(const xmlChar *str);
XMLPUBFUN void
		xmlFreeURI		(xmlURIPtr uri);
XMLPUBFUN xmlChar*
		xmlCanonicPath		(const xmlChar *path);
XMLPUBFUN xmlChar*
		xmlPathToURI		(const xmlChar *path);

#ifdef __cplusplus
}
#endif
#endif /* __XML_URI_H__ */
