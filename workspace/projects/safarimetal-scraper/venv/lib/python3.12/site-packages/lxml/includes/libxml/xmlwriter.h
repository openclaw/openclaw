/*
 * Summary: text writing API for XML
 * Description: text writing API for XML
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Alfred Mickautsch <alfred@mickautsch.de>
 */

#ifndef __XML_XMLWRITER_H__
#define __XML_XMLWRITER_H__

#include <libxml/xmlversion.h>

#ifdef LIBXML_WRITER_ENABLED

#include <stdarg.h>
#include <libxml/xmlIO.h>
#include <libxml/list.h>
#include <libxml/xmlstring.h>

#ifdef __cplusplus
extern "C" {
#endif

    typedef struct _xmlTextWriter xmlTextWriter;
    typedef xmlTextWriter *xmlTextWriterPtr;

/*
 * Constructors & Destructor
 */
    XMLPUBFUN xmlTextWriterPtr
        xmlNewTextWriter(xmlOutputBufferPtr out);
    XMLPUBFUN xmlTextWriterPtr
        xmlNewTextWriterFilename(const char *uri, int compression);
    XMLPUBFUN xmlTextWriterPtr
        xmlNewTextWriterMemory(xmlBufferPtr buf, int compression);
    XMLPUBFUN xmlTextWriterPtr
        xmlNewTextWriterPushParser(xmlParserCtxtPtr ctxt, int compression);
    XMLPUBFUN xmlTextWriterPtr
        xmlNewTextWriterDoc(xmlDocPtr * doc, int compression);
    XMLPUBFUN xmlTextWriterPtr
        xmlNewTextWriterTree(xmlDocPtr doc, xmlNodePtr node,
                             int compression);
    XMLPUBFUN void xmlFreeTextWriter(xmlTextWriterPtr writer);

/*
 * Functions
 */


/*
 * Document
 */
    XMLPUBFUN int
        xmlTextWriterStartDocument(xmlTextWriterPtr writer,
                                   const char *version,
                                   const char *encoding,
                                   const char *standalone);
    XMLPUBFUN int xmlTextWriterEndDocument(xmlTextWriterPtr
                                                   writer);

/*
 * Comments
 */
    XMLPUBFUN int xmlTextWriterStartComment(xmlTextWriterPtr
                                                    writer);
    XMLPUBFUN int xmlTextWriterEndComment(xmlTextWriterPtr writer);
    XMLPUBFUN int
        xmlTextWriterWriteFormatComment(xmlTextWriterPtr writer,
                                        const char *format, ...)
					LIBXML_ATTR_FORMAT(2,3);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatComment(xmlTextWriterPtr writer,
                                         const char *format,
                                         va_list argptr)
					 LIBXML_ATTR_FORMAT(2,0);
    XMLPUBFUN int xmlTextWriterWriteComment(xmlTextWriterPtr
                                                    writer,
                                                    const xmlChar *
                                                    content);

/*
 * Elements
 */
    XMLPUBFUN int
        xmlTextWriterStartElement(xmlTextWriterPtr writer,
                                  const xmlChar * name);
    XMLPUBFUN int xmlTextWriterStartElementNS(xmlTextWriterPtr
                                                      writer,
                                                      const xmlChar *
                                                      prefix,
                                                      const xmlChar * name,
                                                      const xmlChar *
                                                      namespaceURI);
    XMLPUBFUN int xmlTextWriterEndElement(xmlTextWriterPtr writer);
    XMLPUBFUN int xmlTextWriterFullEndElement(xmlTextWriterPtr
                                                      writer);

/*
 * Elements conveniency functions
 */
    XMLPUBFUN int
        xmlTextWriterWriteFormatElement(xmlTextWriterPtr writer,
                                        const xmlChar * name,
                                        const char *format, ...)
					LIBXML_ATTR_FORMAT(3,4);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatElement(xmlTextWriterPtr writer,
                                         const xmlChar * name,
                                         const char *format,
                                         va_list argptr)
					 LIBXML_ATTR_FORMAT(3,0);
    XMLPUBFUN int xmlTextWriterWriteElement(xmlTextWriterPtr
                                                    writer,
                                                    const xmlChar * name,
                                                    const xmlChar *
                                                    content);
    XMLPUBFUN int
        xmlTextWriterWriteFormatElementNS(xmlTextWriterPtr writer,
                                          const xmlChar * prefix,
                                          const xmlChar * name,
                                          const xmlChar * namespaceURI,
                                          const char *format, ...)
					  LIBXML_ATTR_FORMAT(5,6);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatElementNS(xmlTextWriterPtr writer,
                                           const xmlChar * prefix,
                                           const xmlChar * name,
                                           const xmlChar * namespaceURI,
                                           const char *format,
                                           va_list argptr)
					   LIBXML_ATTR_FORMAT(5,0);
    XMLPUBFUN int xmlTextWriterWriteElementNS(xmlTextWriterPtr
                                                      writer,
                                                      const xmlChar *
                                                      prefix,
                                                      const xmlChar * name,
                                                      const xmlChar *
                                                      namespaceURI,
                                                      const xmlChar *
                                                      content);

/*
 * Text
 */
    XMLPUBFUN int
        xmlTextWriterWriteFormatRaw(xmlTextWriterPtr writer,
                                    const char *format, ...)
				    LIBXML_ATTR_FORMAT(2,3);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatRaw(xmlTextWriterPtr writer,
                                     const char *format, va_list argptr)
				     LIBXML_ATTR_FORMAT(2,0);
    XMLPUBFUN int
        xmlTextWriterWriteRawLen(xmlTextWriterPtr writer,
                                 const xmlChar * content, int len);
    XMLPUBFUN int
        xmlTextWriterWriteRaw(xmlTextWriterPtr writer,
                              const xmlChar * content);
    XMLPUBFUN int xmlTextWriterWriteFormatString(xmlTextWriterPtr
                                                         writer,
                                                         const char
                                                         *format, ...)
							 LIBXML_ATTR_FORMAT(2,3);
    XMLPUBFUN int xmlTextWriterWriteVFormatString(xmlTextWriterPtr
                                                          writer,
                                                          const char
                                                          *format,
                                                          va_list argptr)
							  LIBXML_ATTR_FORMAT(2,0);
    XMLPUBFUN int xmlTextWriterWriteString(xmlTextWriterPtr writer,
                                                   const xmlChar *
                                                   content);
    XMLPUBFUN int xmlTextWriterWriteBase64(xmlTextWriterPtr writer,
                                                   const char *data,
                                                   int start, int len);
    XMLPUBFUN int xmlTextWriterWriteBinHex(xmlTextWriterPtr writer,
                                                   const char *data,
                                                   int start, int len);

/*
 * Attributes
 */
    XMLPUBFUN int
        xmlTextWriterStartAttribute(xmlTextWriterPtr writer,
                                    const xmlChar * name);
    XMLPUBFUN int xmlTextWriterStartAttributeNS(xmlTextWriterPtr
                                                        writer,
                                                        const xmlChar *
                                                        prefix,
                                                        const xmlChar *
                                                        name,
                                                        const xmlChar *
                                                        namespaceURI);
    XMLPUBFUN int xmlTextWriterEndAttribute(xmlTextWriterPtr
                                                    writer);

/*
 * Attributes conveniency functions
 */
    XMLPUBFUN int
        xmlTextWriterWriteFormatAttribute(xmlTextWriterPtr writer,
                                          const xmlChar * name,
                                          const char *format, ...)
					  LIBXML_ATTR_FORMAT(3,4);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatAttribute(xmlTextWriterPtr writer,
                                           const xmlChar * name,
                                           const char *format,
                                           va_list argptr)
					   LIBXML_ATTR_FORMAT(3,0);
    XMLPUBFUN int xmlTextWriterWriteAttribute(xmlTextWriterPtr
                                                      writer,
                                                      const xmlChar * name,
                                                      const xmlChar *
                                                      content);
    XMLPUBFUN int
        xmlTextWriterWriteFormatAttributeNS(xmlTextWriterPtr writer,
                                            const xmlChar * prefix,
                                            const xmlChar * name,
                                            const xmlChar * namespaceURI,
                                            const char *format, ...)
					    LIBXML_ATTR_FORMAT(5,6);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatAttributeNS(xmlTextWriterPtr writer,
                                             const xmlChar * prefix,
                                             const xmlChar * name,
                                             const xmlChar * namespaceURI,
                                             const char *format,
                                             va_list argptr)
					     LIBXML_ATTR_FORMAT(5,0);
    XMLPUBFUN int xmlTextWriterWriteAttributeNS(xmlTextWriterPtr
                                                        writer,
                                                        const xmlChar *
                                                        prefix,
                                                        const xmlChar *
                                                        name,
                                                        const xmlChar *
                                                        namespaceURI,
                                                        const xmlChar *
                                                        content);

/*
 * PI's
 */
    XMLPUBFUN int
        xmlTextWriterStartPI(xmlTextWriterPtr writer,
                             const xmlChar * target);
    XMLPUBFUN int xmlTextWriterEndPI(xmlTextWriterPtr writer);

/*
 * PI conveniency functions
 */
    XMLPUBFUN int
        xmlTextWriterWriteFormatPI(xmlTextWriterPtr writer,
                                   const xmlChar * target,
                                   const char *format, ...)
				   LIBXML_ATTR_FORMAT(3,4);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatPI(xmlTextWriterPtr writer,
                                    const xmlChar * target,
                                    const char *format, va_list argptr)
				    LIBXML_ATTR_FORMAT(3,0);
    XMLPUBFUN int
        xmlTextWriterWritePI(xmlTextWriterPtr writer,
                             const xmlChar * target,
                             const xmlChar * content);

/**
 * xmlTextWriterWriteProcessingInstruction:
 *
 * This macro maps to xmlTextWriterWritePI
 */
#define xmlTextWriterWriteProcessingInstruction xmlTextWriterWritePI

/*
 * CDATA
 */
    XMLPUBFUN int xmlTextWriterStartCDATA(xmlTextWriterPtr writer);
    XMLPUBFUN int xmlTextWriterEndCDATA(xmlTextWriterPtr writer);

/*
 * CDATA conveniency functions
 */
    XMLPUBFUN int
        xmlTextWriterWriteFormatCDATA(xmlTextWriterPtr writer,
                                      const char *format, ...)
				      LIBXML_ATTR_FORMAT(2,3);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatCDATA(xmlTextWriterPtr writer,
                                       const char *format, va_list argptr)
				       LIBXML_ATTR_FORMAT(2,0);
    XMLPUBFUN int
        xmlTextWriterWriteCDATA(xmlTextWriterPtr writer,
                                const xmlChar * content);

/*
 * DTD
 */
    XMLPUBFUN int
        xmlTextWriterStartDTD(xmlTextWriterPtr writer,
                              const xmlChar * name,
                              const xmlChar * pubid,
                              const xmlChar * sysid);
    XMLPUBFUN int xmlTextWriterEndDTD(xmlTextWriterPtr writer);

/*
 * DTD conveniency functions
 */
    XMLPUBFUN int
        xmlTextWriterWriteFormatDTD(xmlTextWriterPtr writer,
                                    const xmlChar * name,
                                    const xmlChar * pubid,
                                    const xmlChar * sysid,
                                    const char *format, ...)
				    LIBXML_ATTR_FORMAT(5,6);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatDTD(xmlTextWriterPtr writer,
                                     const xmlChar * name,
                                     const xmlChar * pubid,
                                     const xmlChar * sysid,
                                     const char *format, va_list argptr)
				     LIBXML_ATTR_FORMAT(5,0);
    XMLPUBFUN int
        xmlTextWriterWriteDTD(xmlTextWriterPtr writer,
                              const xmlChar * name,
                              const xmlChar * pubid,
                              const xmlChar * sysid,
                              const xmlChar * subset);

/**
 * xmlTextWriterWriteDocType:
 *
 * this macro maps to xmlTextWriterWriteDTD
 */
#define xmlTextWriterWriteDocType xmlTextWriterWriteDTD

/*
 * DTD element definition
 */
    XMLPUBFUN int
        xmlTextWriterStartDTDElement(xmlTextWriterPtr writer,
                                     const xmlChar * name);
    XMLPUBFUN int xmlTextWriterEndDTDElement(xmlTextWriterPtr
                                                     writer);

/*
 * DTD element definition conveniency functions
 */
    XMLPUBFUN int
        xmlTextWriterWriteFormatDTDElement(xmlTextWriterPtr writer,
                                           const xmlChar * name,
                                           const char *format, ...)
					   LIBXML_ATTR_FORMAT(3,4);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatDTDElement(xmlTextWriterPtr writer,
                                            const xmlChar * name,
                                            const char *format,
                                            va_list argptr)
					    LIBXML_ATTR_FORMAT(3,0);
    XMLPUBFUN int xmlTextWriterWriteDTDElement(xmlTextWriterPtr
                                                       writer,
                                                       const xmlChar *
                                                       name,
                                                       const xmlChar *
                                                       content);

/*
 * DTD attribute list definition
 */
    XMLPUBFUN int
        xmlTextWriterStartDTDAttlist(xmlTextWriterPtr writer,
                                     const xmlChar * name);
    XMLPUBFUN int xmlTextWriterEndDTDAttlist(xmlTextWriterPtr
                                                     writer);

/*
 * DTD attribute list definition conveniency functions
 */
    XMLPUBFUN int
        xmlTextWriterWriteFormatDTDAttlist(xmlTextWriterPtr writer,
                                           const xmlChar * name,
                                           const char *format, ...)
					   LIBXML_ATTR_FORMAT(3,4);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatDTDAttlist(xmlTextWriterPtr writer,
                                            const xmlChar * name,
                                            const char *format,
                                            va_list argptr)
					    LIBXML_ATTR_FORMAT(3,0);
    XMLPUBFUN int xmlTextWriterWriteDTDAttlist(xmlTextWriterPtr
                                                       writer,
                                                       const xmlChar *
                                                       name,
                                                       const xmlChar *
                                                       content);

/*
 * DTD entity definition
 */
    XMLPUBFUN int
        xmlTextWriterStartDTDEntity(xmlTextWriterPtr writer,
                                    int pe, const xmlChar * name);
    XMLPUBFUN int xmlTextWriterEndDTDEntity(xmlTextWriterPtr
                                                    writer);

/*
 * DTD entity definition conveniency functions
 */
    XMLPUBFUN int
        xmlTextWriterWriteFormatDTDInternalEntity(xmlTextWriterPtr writer,
                                                  int pe,
                                                  const xmlChar * name,
                                                  const char *format, ...)
						  LIBXML_ATTR_FORMAT(4,5);
    XMLPUBFUN int
        xmlTextWriterWriteVFormatDTDInternalEntity(xmlTextWriterPtr writer,
                                                   int pe,
                                                   const xmlChar * name,
                                                   const char *format,
                                                   va_list argptr)
						   LIBXML_ATTR_FORMAT(4,0);
    XMLPUBFUN int
        xmlTextWriterWriteDTDInternalEntity(xmlTextWriterPtr writer,
                                            int pe,
                                            const xmlChar * name,
                                            const xmlChar * content);
    XMLPUBFUN int
        xmlTextWriterWriteDTDExternalEntity(xmlTextWriterPtr writer,
                                            int pe,
                                            const xmlChar * name,
                                            const xmlChar * pubid,
                                            const xmlChar * sysid,
                                            const xmlChar * ndataid);
    XMLPUBFUN int
        xmlTextWriterWriteDTDExternalEntityContents(xmlTextWriterPtr
                                                    writer,
                                                    const xmlChar * pubid,
                                                    const xmlChar * sysid,
                                                    const xmlChar *
                                                    ndataid);
    XMLPUBFUN int xmlTextWriterWriteDTDEntity(xmlTextWriterPtr
                                                      writer, int pe,
                                                      const xmlChar * name,
                                                      const xmlChar *
                                                      pubid,
                                                      const xmlChar *
                                                      sysid,
                                                      const xmlChar *
                                                      ndataid,
                                                      const xmlChar *
                                                      content);

/*
 * DTD notation definition
 */
    XMLPUBFUN int
        xmlTextWriterWriteDTDNotation(xmlTextWriterPtr writer,
                                      const xmlChar * name,
                                      const xmlChar * pubid,
                                      const xmlChar * sysid);

/*
 * Indentation
 */
    XMLPUBFUN int
        xmlTextWriterSetIndent(xmlTextWriterPtr writer, int indent);
    XMLPUBFUN int
        xmlTextWriterSetIndentString(xmlTextWriterPtr writer,
                                     const xmlChar * str);

    XMLPUBFUN int
        xmlTextWriterSetQuoteChar(xmlTextWriterPtr writer, xmlChar quotechar);


/*
 * misc
 */
    XMLPUBFUN int xmlTextWriterFlush(xmlTextWriterPtr writer);
    XMLPUBFUN int xmlTextWriterClose(xmlTextWriterPtr writer);

#ifdef __cplusplus
}
#endif

#endif /* LIBXML_WRITER_ENABLED */

#endif                          /* __XML_XMLWRITER_H__ */
