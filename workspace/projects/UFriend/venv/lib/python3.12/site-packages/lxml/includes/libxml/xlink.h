/*
 * Summary: unfinished XLink detection module
 * Description: unfinished XLink detection module
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XLINK_H__
#define __XML_XLINK_H__

#include <libxml/xmlversion.h>
#include <libxml/tree.h>

#ifdef LIBXML_XPTR_ENABLED

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Various defines for the various Link properties.
 *
 * NOTE: the link detection layer will try to resolve QName expansion
 *       of namespaces. If "foo" is the prefix for "http://foo.com/"
 *       then the link detection layer will expand role="foo:myrole"
 *       to "http://foo.com/:myrole".
 * NOTE: the link detection layer will expand URI-References found on
 *       href attributes by using the base mechanism if found.
 */
typedef xmlChar *xlinkHRef;
typedef xmlChar *xlinkRole;
typedef xmlChar *xlinkTitle;

typedef enum {
    XLINK_TYPE_NONE = 0,
    XLINK_TYPE_SIMPLE,
    XLINK_TYPE_EXTENDED,
    XLINK_TYPE_EXTENDED_SET
} xlinkType;

typedef enum {
    XLINK_SHOW_NONE = 0,
    XLINK_SHOW_NEW,
    XLINK_SHOW_EMBED,
    XLINK_SHOW_REPLACE
} xlinkShow;

typedef enum {
    XLINK_ACTUATE_NONE = 0,
    XLINK_ACTUATE_AUTO,
    XLINK_ACTUATE_ONREQUEST
} xlinkActuate;

/**
 * xlinkNodeDetectFunc:
 * @ctx:  user data pointer
 * @node:  the node to check
 *
 * This is the prototype for the link detection routine.
 * It calls the default link detection callbacks upon link detection.
 */
typedef void (*xlinkNodeDetectFunc) (void *ctx, xmlNodePtr node);

/*
 * The link detection module interact with the upper layers using
 * a set of callback registered at parsing time.
 */

/**
 * xlinkSimpleLinkFunk:
 * @ctx:  user data pointer
 * @node:  the node carrying the link
 * @href:  the target of the link
 * @role:  the role string
 * @title:  the link title
 *
 * This is the prototype for a simple link detection callback.
 */
typedef void
(*xlinkSimpleLinkFunk)	(void *ctx,
			 xmlNodePtr node,
			 const xlinkHRef href,
			 const xlinkRole role,
			 const xlinkTitle title);

/**
 * xlinkExtendedLinkFunk:
 * @ctx:  user data pointer
 * @node:  the node carrying the link
 * @nbLocators: the number of locators detected on the link
 * @hrefs:  pointer to the array of locator hrefs
 * @roles:  pointer to the array of locator roles
 * @nbArcs: the number of arcs detected on the link
 * @from:  pointer to the array of source roles found on the arcs
 * @to:  pointer to the array of target roles found on the arcs
 * @show:  array of values for the show attributes found on the arcs
 * @actuate:  array of values for the actuate attributes found on the arcs
 * @nbTitles: the number of titles detected on the link
 * @title:  array of titles detected on the link
 * @langs:  array of xml:lang values for the titles
 *
 * This is the prototype for a extended link detection callback.
 */
typedef void
(*xlinkExtendedLinkFunk)(void *ctx,
			 xmlNodePtr node,
			 int nbLocators,
			 const xlinkHRef *hrefs,
			 const xlinkRole *roles,
			 int nbArcs,
			 const xlinkRole *from,
			 const xlinkRole *to,
			 xlinkShow *show,
			 xlinkActuate *actuate,
			 int nbTitles,
			 const xlinkTitle *titles,
			 const xmlChar **langs);

/**
 * xlinkExtendedLinkSetFunk:
 * @ctx:  user data pointer
 * @node:  the node carrying the link
 * @nbLocators: the number of locators detected on the link
 * @hrefs:  pointer to the array of locator hrefs
 * @roles:  pointer to the array of locator roles
 * @nbTitles: the number of titles detected on the link
 * @title:  array of titles detected on the link
 * @langs:  array of xml:lang values for the titles
 *
 * This is the prototype for a extended link set detection callback.
 */
typedef void
(*xlinkExtendedLinkSetFunk)	(void *ctx,
				 xmlNodePtr node,
				 int nbLocators,
				 const xlinkHRef *hrefs,
				 const xlinkRole *roles,
				 int nbTitles,
				 const xlinkTitle *titles,
				 const xmlChar **langs);

/**
 * This is the structure containing a set of Links detection callbacks.
 *
 * There is no default xlink callbacks, if one want to get link
 * recognition activated, those call backs must be provided before parsing.
 */
typedef struct _xlinkHandler xlinkHandler;
typedef xlinkHandler *xlinkHandlerPtr;
struct _xlinkHandler {
    xlinkSimpleLinkFunk simple;
    xlinkExtendedLinkFunk extended;
    xlinkExtendedLinkSetFunk set;
};

/*
 * The default detection routine, can be overridden, they call the default
 * detection callbacks.
 */

XML_DEPRECATED
XMLPUBFUN xlinkNodeDetectFunc
		xlinkGetDefaultDetect	(void);
XML_DEPRECATED
XMLPUBFUN void
		xlinkSetDefaultDetect	(xlinkNodeDetectFunc func);

/*
 * Routines to set/get the default handlers.
 */
XML_DEPRECATED
XMLPUBFUN xlinkHandlerPtr
		xlinkGetDefaultHandler	(void);
XML_DEPRECATED
XMLPUBFUN void
		xlinkSetDefaultHandler	(xlinkHandlerPtr handler);

/*
 * Link detection module itself.
 */
XMLPUBFUN xlinkType
		xlinkIsLink		(xmlDocPtr doc,
					 xmlNodePtr node);

#ifdef __cplusplus
}
#endif

#endif /* LIBXML_XPTR_ENABLED */

#endif /* __XML_XLINK_H__ */
