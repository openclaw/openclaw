"""
Metadata about languages used by our model training code for our
SingleByteCharSetProbers.  Could be used for other things in the future.

This code is based on the language metadata from the uchardet project.
"""

from string import ascii_letters
from typing import List, Optional

# TODO: Add Ukrainian (KOI8-U)


class Language:
    """Metadata about a language useful for training models

    :ivar name: The human name for the language, in English.
    :type name: str
    :ivar iso_code: 2-letter ISO 639-1 if possible, 3-letter ISO code otherwise,
                    or use another catalog as a last resort.
    :type iso_code: str
    :ivar use_ascii: Whether or not ASCII letters should be included in trained
                     models.
    :type use_ascii: bool
    :ivar charsets: The charsets we want to support and create data for.
    :type charsets: list of str
    :ivar alphabet: The characters in the language's alphabet. If `use_ascii` is
                    `True`, you only need to add those not in the ASCII set.
    :type alphabet: str
    :ivar wiki_start_pages: The Wikipedia pages to start from if we're crawling
                            Wikipedia for training data.
    :type wiki_start_pages: list of str
    """

    def __init__(
        self,
        name: Optional[str] = None,
        iso_code: Optional[str] = None,
        use_ascii: bool = True,
        charsets: Optional[List[str]] = None,
        alphabet: Optional[str] = None,
        wiki_start_pages: Optional[List[str]] = None,
    ) -> None:
        super().__init__()
        self.name = name
        self.iso_code = iso_code
        self.use_ascii = use_ascii
        self.charsets = charsets
        if self.use_ascii:
            if alphabet:
                alphabet += ascii_letters
            else:
                alphabet = ascii_letters
        elif not alphabet:
            raise ValueError("Must supply alphabet if use_ascii is False")
        self.alphabet = "".join(sorted(set(alphabet))) if alphabet else None
        self.wiki_start_pages = wiki_start_pages

    def __repr__(self) -> str:
        param_str = ", ".join(
            f"{k}={v!r}" for k, v in self.__dict__.items() if not k.startswith("_")
        )
        return f"{self.__class__.__name__}({param_str})"


LANGUAGES = {
    "Arabic": Language(
        name="Arabic",
        iso_code="ar",
        use_ascii=False,
        # We only support encodings that use isolated
        # forms, because the current recommendation is
        # that the rendering system handles presentation
        # forms. This means we purposefully skip IBM864.
        charsets=["ISO-8859-6", "WINDOWS-1256", "CP720", "CP864"],
        alphabet="ءآأؤإئابةتثجحخدذرزسشصضطظعغػؼؽؾؿـفقكلمنهوىيًٌٍَُِّ",
        wiki_start_pages=["الصفحة_الرئيسية"],
    ),
    "Belarusian": Language(
        name="Belarusian",
        iso_code="be",
        use_ascii=False,
        charsets=["ISO-8859-5", "WINDOWS-1251", "IBM866", "MacCyrillic"],
        alphabet="АБВГДЕЁЖЗІЙКЛМНОПРСТУЎФХЦЧШЫЬЭЮЯабвгдеёжзійклмнопрстуўфхцчшыьэюяʼ",
        wiki_start_pages=["Галоўная_старонка"],
    ),
    "Bulgarian": Language(
        name="Bulgarian",
        iso_code="bg",
        use_ascii=False,
        charsets=["ISO-8859-5", "WINDOWS-1251", "IBM855"],
        alphabet="АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯабвгдежзийклмнопрстуфхцчшщъьюя",
        wiki_start_pages=["Начална_страница"],
    ),
    "Czech": Language(
        name="Czech",
        iso_code="cz",
        use_ascii=True,
        charsets=["ISO-8859-2", "WINDOWS-1250"],
        alphabet="áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ",
        wiki_start_pages=["Hlavní_strana"],
    ),
    "Danish": Language(
        name="Danish",
        iso_code="da",
        use_ascii=True,
        charsets=["ISO-8859-1", "ISO-8859-15", "WINDOWS-1252", "MacRoman"],
        alphabet="æøåÆØÅ",
        wiki_start_pages=["Forside"],
    ),
    "German": Language(
        name="German",
        iso_code="de",
        use_ascii=True,
        charsets=["ISO-8859-1", "ISO-8859-15", "WINDOWS-1252", "MacRoman"],
        alphabet="äöüßẞÄÖÜ",
        wiki_start_pages=["Wikipedia:Hauptseite"],
    ),
    "Greek": Language(
        name="Greek",
        iso_code="el",
        use_ascii=False,
        charsets=["ISO-8859-7", "WINDOWS-1253"],
        alphabet="αβγδεζηθικλμνξοπρσςτυφχψωάέήίόύώΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΣΤΥΦΧΨΩΆΈΉΊΌΎΏ",
        wiki_start_pages=["Πύλη:Κύρια"],
    ),
    "English": Language(
        name="English",
        iso_code="en",
        use_ascii=True,
        charsets=["ISO-8859-1", "WINDOWS-1252", "MacRoman"],
        wiki_start_pages=["Main_Page"],
    ),
    "Esperanto": Language(
        name="Esperanto",
        iso_code="eo",
        # Q, W, X, and Y not used at all
        use_ascii=False,
        charsets=["ISO-8859-3"],
        alphabet="abcĉdefgĝhĥijĵklmnoprsŝtuŭvzABCĈDEFGĜHĤIJĴKLMNOPRSŜTUŬVZ",
        wiki_start_pages=["Vikipedio:Ĉefpaĝo"],
    ),
    "Spanish": Language(
        name="Spanish",
        iso_code="es",
        use_ascii=True,
        charsets=["ISO-8859-1", "ISO-8859-15", "WINDOWS-1252", "MacRoman"],
        alphabet="ñáéíóúüÑÁÉÍÓÚÜ",
        wiki_start_pages=["Wikipedia:Portada"],
    ),
    "Estonian": Language(
        name="Estonian",
        iso_code="et",
        use_ascii=False,
        charsets=["ISO-8859-4", "ISO-8859-13", "WINDOWS-1257"],
        # C, F, Š, Q, W, X, Y, Z, Ž are only for
        # loanwords
        alphabet="ABDEGHIJKLMNOPRSTUVÕÄÖÜabdeghijklmnoprstuvõäöü",
        wiki_start_pages=["Esileht"],
    ),
    "Finnish": Language(
        name="Finnish",
        iso_code="fi",
        use_ascii=True,
        charsets=["ISO-8859-1", "ISO-8859-15", "WINDOWS-1252", "MacRoman"],
        alphabet="ÅÄÖŠŽåäöšž",
        wiki_start_pages=["Wikipedia:Etusivu"],
    ),
    "French": Language(
        name="French",
        iso_code="fr",
        use_ascii=True,
        charsets=["ISO-8859-1", "ISO-8859-15", "WINDOWS-1252", "MacRoman"],
        alphabet="œàâçèéîïùûêŒÀÂÇÈÉÎÏÙÛÊ",
        wiki_start_pages=["Wikipédia:Accueil_principal", "Bœuf (animal)"],
    ),
    "Hebrew": Language(
        name="Hebrew",
        iso_code="he",
        use_ascii=False,
        charsets=["ISO-8859-8", "WINDOWS-1255"],
        alphabet="אבגדהוזחטיךכלםמןנסעףפץצקרשתװױײ",
        wiki_start_pages=["עמוד_ראשי"],
    ),
    "Croatian": Language(
        name="Croatian",
        iso_code="hr",
        # Q, W, X, Y are only used for foreign words.
        use_ascii=False,
        charsets=["ISO-8859-2", "WINDOWS-1250"],
        alphabet="abcčćdđefghijklmnoprsštuvzžABCČĆDĐEFGHIJKLMNOPRSŠTUVZŽ",
        wiki_start_pages=["Glavna_stranica"],
    ),
    "Hungarian": Language(
        name="Hungarian",
        iso_code="hu",
        # Q, W, X, Y are only used for foreign words.
        use_ascii=False,
        charsets=["ISO-8859-2", "WINDOWS-1250"],
        alphabet="abcdefghijklmnoprstuvzáéíóöőúüűABCDEFGHIJKLMNOPRSTUVZÁÉÍÓÖŐÚÜŰ",
        wiki_start_pages=["Kezdőlap"],
    ),
    "Italian": Language(
        name="Italian",
        iso_code="it",
        use_ascii=True,
        charsets=["ISO-8859-1", "ISO-8859-15", "WINDOWS-1252", "MacRoman"],
        alphabet="ÀÈÉÌÒÓÙàèéìòóù",
        wiki_start_pages=["Pagina_principale"],
    ),
    "Lithuanian": Language(
        name="Lithuanian",
        iso_code="lt",
        use_ascii=False,
        charsets=["ISO-8859-13", "WINDOWS-1257", "ISO-8859-4"],
        # Q, W, and X not used at all
        alphabet="AĄBCČDEĘĖFGHIĮYJKLMNOPRSŠTUŲŪVZŽaąbcčdeęėfghiįyjklmnoprsštuųūvzž",
        wiki_start_pages=["Pagrindinis_puslapis"],
    ),
    "Latvian": Language(
        name="Latvian",
        iso_code="lv",
        use_ascii=False,
        charsets=["ISO-8859-13", "WINDOWS-1257", "ISO-8859-4"],
        # Q, W, X, Y are only for loanwords
        alphabet="AĀBCČDEĒFGĢHIĪJKĶLĻMNŅOPRSŠTUŪVZŽaābcčdeēfgģhiījkķlļmnņoprsštuūvzž",
        wiki_start_pages=["Sākumlapa"],
    ),
    "Macedonian": Language(
        name="Macedonian",
        iso_code="mk",
        use_ascii=False,
        charsets=["ISO-8859-5", "WINDOWS-1251", "MacCyrillic", "IBM855"],
        alphabet="АБВГДЃЕЖЗЅИЈКЛЉМНЊОПРСТЌУФХЦЧЏШабвгдѓежзѕијклљмнњопрстќуфхцчџш",
        wiki_start_pages=["Главна_страница"],
    ),
    "Dutch": Language(
        name="Dutch",
        iso_code="nl",
        use_ascii=True,
        charsets=["ISO-8859-1", "WINDOWS-1252", "MacRoman"],
        wiki_start_pages=["Hoofdpagina"],
    ),
    "Polish": Language(
        name="Polish",
        iso_code="pl",
        # Q and X are only used for foreign words.
        use_ascii=False,
        charsets=["ISO-8859-2", "WINDOWS-1250"],
        alphabet="AĄBCĆDEĘFGHIJKLŁMNŃOÓPRSŚTUWYZŹŻaąbcćdeęfghijklłmnńoóprsśtuwyzźż",
        wiki_start_pages=["Wikipedia:Strona_główna"],
    ),
    "Portuguese": Language(
        name="Portuguese",
        iso_code="pt",
        use_ascii=True,
        charsets=["ISO-8859-1", "ISO-8859-15", "WINDOWS-1252", "MacRoman"],
        alphabet="ÁÂÃÀÇÉÊÍÓÔÕÚáâãàçéêíóôõú",
        wiki_start_pages=["Wikipédia:Página_principal"],
    ),
    "Romanian": Language(
        name="Romanian",
        iso_code="ro",
        use_ascii=True,
        charsets=["ISO-8859-2", "WINDOWS-1250"],
        alphabet="ăâîșțĂÂÎȘȚ",
        wiki_start_pages=["Pagina_principală"],
    ),
    "Russian": Language(
        name="Russian",
        iso_code="ru",
        use_ascii=False,
        charsets=[
            "ISO-8859-5",
            "WINDOWS-1251",
            "KOI8-R",
            "MacCyrillic",
            "IBM866",
            "IBM855",
        ],
        alphabet="абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ",
        wiki_start_pages=["Заглавная_страница"],
    ),
    "Slovak": Language(
        name="Slovak",
        iso_code="sk",
        use_ascii=True,
        charsets=["ISO-8859-2", "WINDOWS-1250"],
        alphabet="áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ",
        wiki_start_pages=["Hlavná_stránka"],
    ),
    "Slovene": Language(
        name="Slovene",
        iso_code="sl",
        # Q, W, X, Y are only used for foreign words.
        use_ascii=False,
        charsets=["ISO-8859-2", "WINDOWS-1250"],
        alphabet="abcčdefghijklmnoprsštuvzžABCČDEFGHIJKLMNOPRSŠTUVZŽ",
        wiki_start_pages=["Glavna_stran"],
    ),
    # Serbian can be written in both Latin and Cyrillic, but there's no
    # simple way to get the Latin alphabet pages from Wikipedia through
    # the API, so for now we just support Cyrillic.
    "Serbian": Language(
        name="Serbian",
        iso_code="sr",
        alphabet="АБВГДЂЕЖЗИЈКЛЉМНЊОПРСТЋУФХЦЧЏШабвгдђежзијклљмнњопрстћуфхцчџш",
        charsets=["ISO-8859-5", "WINDOWS-1251", "MacCyrillic", "IBM855"],
        wiki_start_pages=["Главна_страна"],
    ),
    "Thai": Language(
        name="Thai",
        iso_code="th",
        use_ascii=False,
        charsets=["ISO-8859-11", "TIS-620", "CP874"],
        alphabet="กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรฤลฦวศษสหฬอฮฯะัาำิีึืฺุู฿เแโใไๅๆ็่้๊๋์ํ๎๏๐๑๒๓๔๕๖๗๘๙๚๛",
        wiki_start_pages=["หน้าหลัก"],
    ),
    "Turkish": Language(
        name="Turkish",
        iso_code="tr",
        # Q, W, and X are not used by Turkish
        use_ascii=False,
        charsets=["ISO-8859-3", "ISO-8859-9", "WINDOWS-1254"],
        alphabet="abcçdefgğhıijklmnoöprsştuüvyzâîûABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZÂÎÛ",
        wiki_start_pages=["Ana_Sayfa"],
    ),
    "Vietnamese": Language(
        name="Vietnamese",
        iso_code="vi",
        use_ascii=False,
        # Windows-1258 is the only common 8-bit
        # Vietnamese encoding supported by Python.
        # From Wikipedia:
        # For systems that lack support for Unicode,
        # dozens of 8-bit Vietnamese code pages are
        # available.[1] The most common are VISCII
        # (TCVN 5712:1993), VPS, and Windows-1258.[3]
        # Where ASCII is required, such as when
        # ensuring readability in plain text e-mail,
        # Vietnamese letters are often encoded
        # according to Vietnamese Quoted-Readable
        # (VIQR) or VSCII Mnemonic (VSCII-MNEM),[4]
        # though usage of either variable-width
        # scheme has declined dramatically following
        # the adoption of Unicode on the World Wide
        # Web.
        charsets=["WINDOWS-1258"],
        alphabet="aăâbcdđeêghiklmnoôơpqrstuưvxyAĂÂBCDĐEÊGHIKLMNOÔƠPQRSTUƯVXY",
        wiki_start_pages=["Chữ_Quốc_ngữ"],
    ),
}
