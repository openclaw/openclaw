/*
 * Summary: regular expressions handling
 * Description: basic API for libxml regular expressions handling used
 *              for XML Schemas and validation.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_REGEXP_H__
#define __XML_REGEXP_H__

#include <stdio.h>
#include <libxml/xmlversion.h>
#include <libxml/xmlstring.h>

#ifdef LIBXML_REGEXP_ENABLED

#ifdef __cplusplus
extern "C" {
#endif

/**
 * xmlRegexpPtr:
 *
 * A libxml regular expression, they can actually be far more complex
 * thank the POSIX regex expressions.
 */
typedef struct _xmlRegexp xmlRegexp;
typedef xmlRegexp *xmlRegexpPtr;

/**
 * xmlRegExecCtxtPtr:
 *
 * A libxml progressive regular expression evaluation context
 */
typedef struct _xmlRegExecCtxt xmlRegExecCtxt;
typedef xmlRegExecCtxt *xmlRegExecCtxtPtr;

/*
 * The POSIX like API
 */
XMLPUBFUN xmlRegexpPtr
		    xmlRegexpCompile	(const xmlChar *regexp);
XMLPUBFUN void			 xmlRegFreeRegexp(xmlRegexpPtr regexp);
XMLPUBFUN int
		    xmlRegexpExec	(xmlRegexpPtr comp,
					 const xmlChar *value);
XML_DEPRECATED
XMLPUBFUN void
		    xmlRegexpPrint	(FILE *output,
					 xmlRegexpPtr regexp);
XMLPUBFUN int
		    xmlRegexpIsDeterminist(xmlRegexpPtr comp);

/**
 * xmlRegExecCallbacks:
 * @exec: the regular expression context
 * @token: the current token string
 * @transdata: transition data
 * @inputdata: input data
 *
 * Callback function when doing a transition in the automata
 */
typedef void (*xmlRegExecCallbacks) (xmlRegExecCtxtPtr exec,
	                             const xmlChar *token,
				     void *transdata,
				     void *inputdata);

/*
 * The progressive API
 */
XML_DEPRECATED
XMLPUBFUN xmlRegExecCtxtPtr
		    xmlRegNewExecCtxt	(xmlRegexpPtr comp,
					 xmlRegExecCallbacks callback,
					 void *data);
XML_DEPRECATED
XMLPUBFUN void
		    xmlRegFreeExecCtxt	(xmlRegExecCtxtPtr exec);
XML_DEPRECATED
XMLPUBFUN int
		    xmlRegExecPushString(xmlRegExecCtxtPtr exec,
					 const xmlChar *value,
					 void *data);
XML_DEPRECATED
XMLPUBFUN int
		    xmlRegExecPushString2(xmlRegExecCtxtPtr exec,
					 const xmlChar *value,
					 const xmlChar *value2,
					 void *data);

XML_DEPRECATED
XMLPUBFUN int
		    xmlRegExecNextValues(xmlRegExecCtxtPtr exec,
					 int *nbval,
					 int *nbneg,
					 xmlChar **values,
					 int *terminal);
XML_DEPRECATED
XMLPUBFUN int
		    xmlRegExecErrInfo	(xmlRegExecCtxtPtr exec,
					 const xmlChar **string,
					 int *nbval,
					 int *nbneg,
					 xmlChar **values,
					 int *terminal);

#ifdef __cplusplus
}
#endif

#endif /* LIBXML_REGEXP_ENABLED */

#endif /*__XML_REGEXP_H__ */
