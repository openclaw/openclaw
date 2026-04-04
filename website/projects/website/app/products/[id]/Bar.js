export default function Bar({ product }) {
  const {
    bar_text_1,
    bar_text_2,
    bar_text_3,
    bar_text_4,
  } = product;
  const texts = [
    bar_text_1,
    bar_text_2,
    bar_text_3,
    bar_text_4,
  ];

  return (
    <div className="grid grid-cols-2 gap-5 p-5 rounded-3xl bg-white/20 shadow-xl lg:grid-cols-4 lg:gap-0 lg:divide-x lg:divide-white/25">
      {texts.map(text => (
        <span key={text} className="flex justify-center items-center text-center text-lg/[1.25] font-semibold lg:px-5">
          {text}
        </span>
      ))}
    </div>
  );
}
