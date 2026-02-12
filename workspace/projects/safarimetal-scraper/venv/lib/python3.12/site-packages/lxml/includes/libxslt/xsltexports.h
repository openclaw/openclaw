/*
 * Summary: macros for marking symbols as exportable/importable.
 * Description: macros for marking symbols as exportable/importable.
 *
 * Copy: See Copyright for the status of this software.
 */

#ifndef __XSLT_EXPORTS_H__
#define __XSLT_EXPORTS_H__

#if defined(_WIN32) || defined(__CYGWIN__)
/** DOC_DISABLE */

#ifdef LIBXSLT_STATIC
  #define XSLTPUBLIC
#elif defined(IN_LIBXSLT)
  #define XSLTPUBLIC __declspec(dllexport)
#else
  #define XSLTPUBLIC __declspec(dllimport)
#endif

#define XSLTCALL __cdecl

/** DOC_ENABLE */
#else /* not Windows */

/**
 * XSLTPUBLIC:
 *
 * Macro which declares a public symbol
 */
#define XSLTPUBLIC

/**
 * XSLTCALL:
 *
 * Macro which declares the calling convention for exported functions
 */
#define XSLTCALL

#endif /* platform switch */

/*
 * XSLTPUBFUN:
 *
 * Macro which declares an exportable function
 */
#define XSLTPUBFUN XSLTPUBLIC

/**
 * XSLTPUBVAR:
 *
 * Macro which declares an exportable variable
 */
#define XSLTPUBVAR XSLTPUBLIC extern

/* Compatibility */
#if !defined(LIBXSLT_PUBLIC)
#define LIBXSLT_PUBLIC XSLTPUBVAR
#endif

#endif /* __XSLT_EXPORTS_H__ */


