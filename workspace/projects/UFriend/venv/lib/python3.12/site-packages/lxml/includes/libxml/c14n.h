/*
 * Summary: Provide Canonical XML and Exclusive XML Canonicalization
 * Description: the c14n modules provides a
 *
 * "Canonical XML" implementation
 * http://www.w3.org/TR/xml-c14n
 *
 * and an
 *
 * "Exclusive XML Canonicalization" implementation
 * http://www.w3.org/TR/xml-exc-c14n

 * Copy: See Copyright for the status of this software.
 *
 * Author: Aleksey Sanin <aleksey@aleksey.com>
 */
#ifndef __XML_C14N_H__
#define __XML_C14N_H__

#include <libxml/xmlversion.h>

#ifdef LIBXML_C14N_ENABLED

#include <libxml/tree.h>
#include <libxml/xpath.h>

#ifdef __cplusplus
extern "C" {
#endif /* __cplusplus */

/*
 * XML Canonicalization
 * http://www.w3.org/TR/xml-c14n
 *
 * Exclusive XML Canonicalization
 * http://www.w3.org/TR/xml-exc-c14n
 *
 * Canonical form of an XML document could be created if and only if
 *  a) default attributes (if any) are added to all nodes
 *  b) all character and parsed entity references are resolved
 * In order to achieve this in libxml2 the document MUST be loaded with
 * following options: XML_PARSE_DTDATTR | XML_PARSE_NOENT
 */

/*
 * xmlC14NMode:
 *
 * Predefined values for C14N modes
 *
 */
typedef enum {
    XML_C14N_1_0            = 0,    /* Original C14N 1.0 spec */
    XML_C14N_EXCLUSIVE_1_0  = 1,    /* Exclusive C14N 1.0 spec */
    XML_C14N_1_1            = 2     /* C14N 1.1 spec */
} xmlC14NMode;

XMLPUBFUN int
		xmlC14NDocSaveTo	(xmlDocPtr doc,
					 xmlNodeSetPtr nodes,
					 int mode, /* a xmlC14NMode */
					 xmlChar **inclusive_ns_prefixes,
					 int with_comments,
					 xmlOutputBufferPtr buf);

XMLPUBFUN int
		xmlC14NDocDumpMemory	(xmlDocPtr doc,
					 xmlNodeSetPtr nodes,
					 int mode, /* a xmlC14NMode */
					 xmlChar **inclusive_ns_prefixes,
					 int with_comments,
					 xmlChar **doc_txt_ptr);

XMLPUBFUN int
		xmlC14NDocSave		(xmlDocPtr doc,
					 xmlNodeSetPtr nodes,
					 int mode, /* a xmlC14NMode */
					 xmlChar **inclusive_ns_prefixes,
					 int with_comments,
					 const char* filename,
					 int compression);


/**
 * This is the core C14N function
 */
/**
 * xmlC14NIsVisibleCallback:
 * @user_data: user data
 * @node: the current node
 * @parent: the parent node
 *
 * Signature for a C14N callback on visible nodes
 *
 * Returns 1 if the node should be included
 */
typedef int (*xmlC14NIsVisibleCallback)	(void* user_data,
					 xmlNodePtr node,
					 xmlNodePtr parent);

XMLPUBFUN int
		xmlC14NExecute		(xmlDocPtr doc,
					 xmlC14NIsVisibleCallback is_visible_callback,
					 void* user_data,
					 int mode, /* a xmlC14NMode */
					 xmlChar **inclusive_ns_prefixes,
					 int with_comments,
					 xmlOutputBufferPtr buf);

#ifdef __cplusplus
}
#endif /* __cplusplus */

#endif /* LIBXML_C14N_ENABLED */
#endif /* __XML_C14N_H__ */

