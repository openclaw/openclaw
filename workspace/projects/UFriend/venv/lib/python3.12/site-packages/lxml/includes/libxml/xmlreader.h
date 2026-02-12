/*
 * Summary: the XMLReader implementation
 * Description: API of the XML streaming API based on C# interfaces.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XMLREADER_H__
#define __XML_XMLREADER_H__

#include <libxml/xmlversion.h>
#include <libxml/tree.h>
#include <libxml/xmlerror.h>
#include <libxml/xmlIO.h>
#ifdef LIBXML_RELAXNG_ENABLED
#include <libxml/relaxng.h>
#endif
#ifdef LIBXML_SCHEMAS_ENABLED
#include <libxml/xmlschemas.h>
#endif
#include <libxml/parser.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * xmlParserSeverities:
 *
 * How severe an error callback is when the per-reader error callback API
 * is used.
 */
typedef enum {
    XML_PARSER_SEVERITY_VALIDITY_WARNING = 1,
    XML_PARSER_SEVERITY_VALIDITY_ERROR = 2,
    XML_PARSER_SEVERITY_WARNING = 3,
    XML_PARSER_SEVERITY_ERROR = 4
} xmlParserSeverities;

#ifdef LIBXML_READER_ENABLED

/**
 * xmlTextReaderMode:
 *
 * Internal state values for the reader.
 */
typedef enum {
    XML_TEXTREADER_MODE_INITIAL = 0,
    XML_TEXTREADER_MODE_INTERACTIVE = 1,
    XML_TEXTREADER_MODE_ERROR = 2,
    XML_TEXTREADER_MODE_EOF =3,
    XML_TEXTREADER_MODE_CLOSED = 4,
    XML_TEXTREADER_MODE_READING = 5
} xmlTextReaderMode;

/**
 * xmlParserProperties:
 *
 * Some common options to use with xmlTextReaderSetParserProp, but it
 * is better to use xmlParserOption and the xmlReaderNewxxx and
 * xmlReaderForxxx APIs now.
 */
typedef enum {
    XML_PARSER_LOADDTD = 1,
    XML_PARSER_DEFAULTATTRS = 2,
    XML_PARSER_VALIDATE = 3,
    XML_PARSER_SUBST_ENTITIES = 4
} xmlParserProperties;

/**
 * xmlReaderTypes:
 *
 * Predefined constants for the different types of nodes.
 */
typedef enum {
    XML_READER_TYPE_NONE = 0,
    XML_READER_TYPE_ELEMENT = 1,
    XML_READER_TYPE_ATTRIBUTE = 2,
    XML_READER_TYPE_TEXT = 3,
    XML_READER_TYPE_CDATA = 4,
    XML_READER_TYPE_ENTITY_REFERENCE = 5,
    XML_READER_TYPE_ENTITY = 6,
    XML_READER_TYPE_PROCESSING_INSTRUCTION = 7,
    XML_READER_TYPE_COMMENT = 8,
    XML_READER_TYPE_DOCUMENT = 9,
    XML_READER_TYPE_DOCUMENT_TYPE = 10,
    XML_READER_TYPE_DOCUMENT_FRAGMENT = 11,
    XML_READER_TYPE_NOTATION = 12,
    XML_READER_TYPE_WHITESPACE = 13,
    XML_READER_TYPE_SIGNIFICANT_WHITESPACE = 14,
    XML_READER_TYPE_END_ELEMENT = 15,
    XML_READER_TYPE_END_ENTITY = 16,
    XML_READER_TYPE_XML_DECLARATION = 17
} xmlReaderTypes;

/**
 * xmlTextReader:
 *
 * Structure for an xmlReader context.
 */
typedef struct _xmlTextReader xmlTextReader;

/**
 * xmlTextReaderPtr:
 *
 * Pointer to an xmlReader context.
 */
typedef xmlTextReader *xmlTextReaderPtr;

/*
 * Constructors & Destructor
 */
XMLPUBFUN xmlTextReaderPtr
			xmlNewTextReader	(xmlParserInputBufferPtr input,
	                                         const char *URI);
XMLPUBFUN xmlTextReaderPtr
			xmlNewTextReaderFilename(const char *URI);

XMLPUBFUN void
			xmlFreeTextReader	(xmlTextReaderPtr reader);

XMLPUBFUN int
            xmlTextReaderSetup(xmlTextReaderPtr reader,
                   xmlParserInputBufferPtr input, const char *URL,
                   const char *encoding, int options);
XMLPUBFUN void
            xmlTextReaderSetMaxAmplification(xmlTextReaderPtr reader,
                   unsigned maxAmpl);
XMLPUBFUN const xmlError *
            xmlTextReaderGetLastError(xmlTextReaderPtr reader);

/*
 * Iterators
 */
XMLPUBFUN int
			xmlTextReaderRead	(xmlTextReaderPtr reader);

#ifdef LIBXML_WRITER_ENABLED
XMLPUBFUN xmlChar *
			xmlTextReaderReadInnerXml(xmlTextReaderPtr reader);

XMLPUBFUN xmlChar *
			xmlTextReaderReadOuterXml(xmlTextReaderPtr reader);
#endif

XMLPUBFUN xmlChar *
			xmlTextReaderReadString	(xmlTextReaderPtr reader);
XMLPUBFUN int
			xmlTextReaderReadAttributeValue(xmlTextReaderPtr reader);

/*
 * Attributes of the node
 */
XMLPUBFUN int
			xmlTextReaderAttributeCount(xmlTextReaderPtr reader);
XMLPUBFUN int
			xmlTextReaderDepth	(xmlTextReaderPtr reader);
XMLPUBFUN int
			xmlTextReaderHasAttributes(xmlTextReaderPtr reader);
XMLPUBFUN int
			xmlTextReaderHasValue(xmlTextReaderPtr reader);
XMLPUBFUN int
			xmlTextReaderIsDefault	(xmlTextReaderPtr reader);
XMLPUBFUN int
			xmlTextReaderIsEmptyElement(xmlTextReaderPtr reader);
XMLPUBFUN int
			xmlTextReaderNodeType	(xmlTextReaderPtr reader);
XMLPUBFUN int
			xmlTextReaderQuoteChar	(xmlTextReaderPtr reader);
XMLPUBFUN int
			xmlTextReaderReadState	(xmlTextReaderPtr reader);
XMLPUBFUN int
                        xmlTextReaderIsNamespaceDecl(xmlTextReaderPtr reader);

XMLPUBFUN const xmlChar *
		    xmlTextReaderConstBaseUri	(xmlTextReaderPtr reader);
XMLPUBFUN const xmlChar *
		    xmlTextReaderConstLocalName	(xmlTextReaderPtr reader);
XMLPUBFUN const xmlChar *
		    xmlTextReaderConstName	(xmlTextReaderPtr reader);
XMLPUBFUN const xmlChar *
		    xmlTextReaderConstNamespaceUri(xmlTextReaderPtr reader);
XMLPUBFUN const xmlChar *
		    xmlTextReaderConstPrefix	(xmlTextReaderPtr reader);
XMLPUBFUN const xmlChar *
		    xmlTextReaderConstXmlLang	(xmlTextReaderPtr reader);
XMLPUBFUN const xmlChar *
		    xmlTextReaderConstString	(xmlTextReaderPtr reader,
						 const xmlChar *str);
XMLPUBFUN const xmlChar *
		    xmlTextReaderConstValue	(xmlTextReaderPtr reader);

/*
 * use the Const version of the routine for
 * better performance and simpler code
 */
XMLPUBFUN xmlChar *
			xmlTextReaderBaseUri	(xmlTextReaderPtr reader);
XMLPUBFUN xmlChar *
			xmlTextReaderLocalName	(xmlTextReaderPtr reader);
XMLPUBFUN xmlChar *
			xmlTextReaderName	(xmlTextReaderPtr reader);
XMLPUBFUN xmlChar *
			xmlTextReaderNamespaceUri(xmlTextReaderPtr reader);
XMLPUBFUN xmlChar *
			xmlTextReaderPrefix	(xmlTextReaderPtr reader);
XMLPUBFUN xmlChar *
			xmlTextReaderXmlLang	(xmlTextReaderPtr reader);
XMLPUBFUN xmlChar *
			xmlTextReaderValue	(xmlTextReaderPtr reader);

/*
 * Methods of the XmlTextReader
 */
XMLPUBFUN int
		    xmlTextReaderClose		(xmlTextReaderPtr reader);
XMLPUBFUN xmlChar *
		    xmlTextReaderGetAttributeNo	(xmlTextReaderPtr reader,
						 int no);
XMLPUBFUN xmlChar *
		    xmlTextReaderGetAttribute	(xmlTextReaderPtr reader,
						 const xmlChar *name);
XMLPUBFUN xmlChar *
		    xmlTextReaderGetAttributeNs	(xmlTextReaderPtr reader,
						 const xmlChar *localName,
						 const xmlChar *namespaceURI);
XMLPUBFUN xmlParserInputBufferPtr
		    xmlTextReaderGetRemainder	(xmlTextReaderPtr reader);
XMLPUBFUN xmlChar *
		    xmlTextReaderLookupNamespace(xmlTextReaderPtr reader,
						 const xmlChar *prefix);
XMLPUBFUN int
		    xmlTextReaderMoveToAttributeNo(xmlTextReaderPtr reader,
						 int no);
XMLPUBFUN int
		    xmlTextReaderMoveToAttribute(xmlTextReaderPtr reader,
						 const xmlChar *name);
XMLPUBFUN int
		    xmlTextReaderMoveToAttributeNs(xmlTextReaderPtr reader,
						 const xmlChar *localName,
						 const xmlChar *namespaceURI);
XMLPUBFUN int
		    xmlTextReaderMoveToFirstAttribute(xmlTextReaderPtr reader);
XMLPUBFUN int
		    xmlTextReaderMoveToNextAttribute(xmlTextReaderPtr reader);
XMLPUBFUN int
		    xmlTextReaderMoveToElement	(xmlTextReaderPtr reader);
XMLPUBFUN int
		    xmlTextReaderNormalization	(xmlTextReaderPtr reader);
XMLPUBFUN const xmlChar *
		    xmlTextReaderConstEncoding  (xmlTextReaderPtr reader);

/*
 * Extensions
 */
XMLPUBFUN int
		    xmlTextReaderSetParserProp	(xmlTextReaderPtr reader,
						 int prop,
						 int value);
XMLPUBFUN int
		    xmlTextReaderGetParserProp	(xmlTextReaderPtr reader,
						 int prop);
XMLPUBFUN xmlNodePtr
		    xmlTextReaderCurrentNode	(xmlTextReaderPtr reader);

XMLPUBFUN int
            xmlTextReaderGetParserLineNumber(xmlTextReaderPtr reader);

XMLPUBFUN int
            xmlTextReaderGetParserColumnNumber(xmlTextReaderPtr reader);

XMLPUBFUN xmlNodePtr
		    xmlTextReaderPreserve	(xmlTextReaderPtr reader);
#ifdef LIBXML_PATTERN_ENABLED
XMLPUBFUN int
		    xmlTextReaderPreservePattern(xmlTextReaderPtr reader,
						 const xmlChar *pattern,
						 const xmlChar **namespaces);
#endif /* LIBXML_PATTERN_ENABLED */
XMLPUBFUN xmlDocPtr
		    xmlTextReaderCurrentDoc	(xmlTextReaderPtr reader);
XMLPUBFUN xmlNodePtr
		    xmlTextReaderExpand		(xmlTextReaderPtr reader);
XMLPUBFUN int
		    xmlTextReaderNext		(xmlTextReaderPtr reader);
XMLPUBFUN int
		    xmlTextReaderNextSibling	(xmlTextReaderPtr reader);
XMLPUBFUN int
		    xmlTextReaderIsValid	(xmlTextReaderPtr reader);
#ifdef LIBXML_RELAXNG_ENABLED
XMLPUBFUN int
		    xmlTextReaderRelaxNGValidate(xmlTextReaderPtr reader,
						 const char *rng);
XMLPUBFUN int
		    xmlTextReaderRelaxNGValidateCtxt(xmlTextReaderPtr reader,
						 xmlRelaxNGValidCtxtPtr ctxt,
						 int options);

XMLPUBFUN int
		    xmlTextReaderRelaxNGSetSchema(xmlTextReaderPtr reader,
						 xmlRelaxNGPtr schema);
#endif
#ifdef LIBXML_SCHEMAS_ENABLED
XMLPUBFUN int
		    xmlTextReaderSchemaValidate	(xmlTextReaderPtr reader,
						 const char *xsd);
XMLPUBFUN int
		    xmlTextReaderSchemaValidateCtxt(xmlTextReaderPtr reader,
						 xmlSchemaValidCtxtPtr ctxt,
						 int options);
XMLPUBFUN int
		    xmlTextReaderSetSchema	(xmlTextReaderPtr reader,
						 xmlSchemaPtr schema);
#endif
XMLPUBFUN const xmlChar *
		    xmlTextReaderConstXmlVersion(xmlTextReaderPtr reader);
XMLPUBFUN int
		    xmlTextReaderStandalone     (xmlTextReaderPtr reader);


/*
 * Index lookup
 */
XMLPUBFUN long
		xmlTextReaderByteConsumed	(xmlTextReaderPtr reader);

/*
 * New more complete APIs for simpler creation and reuse of readers
 */
XMLPUBFUN xmlTextReaderPtr
		xmlReaderWalker		(xmlDocPtr doc);
XMLPUBFUN xmlTextReaderPtr
		xmlReaderForDoc		(const xmlChar * cur,
					 const char *URL,
					 const char *encoding,
					 int options);
XMLPUBFUN xmlTextReaderPtr
		xmlReaderForFile	(const char *filename,
					 const char *encoding,
					 int options);
XMLPUBFUN xmlTextReaderPtr
		xmlReaderForMemory	(const char *buffer,
					 int size,
					 const char *URL,
					 const char *encoding,
					 int options);
XMLPUBFUN xmlTextReaderPtr
		xmlReaderForFd		(int fd,
					 const char *URL,
					 const char *encoding,
					 int options);
XMLPUBFUN xmlTextReaderPtr
		xmlReaderForIO		(xmlInputReadCallback ioread,
					 xmlInputCloseCallback ioclose,
					 void *ioctx,
					 const char *URL,
					 const char *encoding,
					 int options);

XMLPUBFUN int
		xmlReaderNewWalker	(xmlTextReaderPtr reader,
					 xmlDocPtr doc);
XMLPUBFUN int
		xmlReaderNewDoc		(xmlTextReaderPtr reader,
					 const xmlChar * cur,
					 const char *URL,
					 const char *encoding,
					 int options);
XMLPUBFUN int
		xmlReaderNewFile	(xmlTextReaderPtr reader,
					 const char *filename,
					 const char *encoding,
					 int options);
XMLPUBFUN int
		xmlReaderNewMemory	(xmlTextReaderPtr reader,
					 const char *buffer,
					 int size,
					 const char *URL,
					 const char *encoding,
					 int options);
XMLPUBFUN int
		xmlReaderNewFd		(xmlTextReaderPtr reader,
					 int fd,
					 const char *URL,
					 const char *encoding,
					 int options);
XMLPUBFUN int
		xmlReaderNewIO		(xmlTextReaderPtr reader,
					 xmlInputReadCallback ioread,
					 xmlInputCloseCallback ioclose,
					 void *ioctx,
					 const char *URL,
					 const char *encoding,
					 int options);
/*
 * Error handling extensions
 */
typedef void *  xmlTextReaderLocatorPtr;

/**
 * xmlTextReaderErrorFunc:
 * @arg: the user argument
 * @msg: the message
 * @severity: the severity of the error
 * @locator: a locator indicating where the error occurred
 *
 * Signature of an error callback from a reader parser
 */
typedef void (*xmlTextReaderErrorFunc)(void *arg,
					       const char *msg,
					       xmlParserSeverities severity,
					       xmlTextReaderLocatorPtr locator);
XMLPUBFUN int
	    xmlTextReaderLocatorLineNumber(xmlTextReaderLocatorPtr locator);
XMLPUBFUN xmlChar *
	    xmlTextReaderLocatorBaseURI (xmlTextReaderLocatorPtr locator);
XMLPUBFUN void
	    xmlTextReaderSetErrorHandler(xmlTextReaderPtr reader,
					 xmlTextReaderErrorFunc f,
					 void *arg);
XMLPUBFUN void
	    xmlTextReaderSetStructuredErrorHandler(xmlTextReaderPtr reader,
						   xmlStructuredErrorFunc f,
						   void *arg);
XMLPUBFUN void
	    xmlTextReaderGetErrorHandler(xmlTextReaderPtr reader,
					 xmlTextReaderErrorFunc *f,
					 void **arg);

XMLPUBFUN void
	    xmlTextReaderSetResourceLoader(xmlTextReaderPtr reader,
					   xmlResourceLoader loader,
					   void *data);

#endif /* LIBXML_READER_ENABLED */

#ifdef __cplusplus
}
#endif

#endif /* __XML_XMLREADER_H__ */

