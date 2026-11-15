'use strict';

// Android metadata in the existing MSX portal's public JSON format. No title,
// film identifier, or search result is special-cased here.
var VERSION = 'android-catalog-v1';
// Labels extracted from the official Android MessageBundle_ru.properties.
var DEFAULT_DICTIONARY = {"genres":[{"id":"tv","title":"\u0422\u0412 \u0438 \u0432\u0438\u0434\u0435\u043e"},{"id":"1","title":"\u0423\u0436\u0430\u0441\u044b","slug":"uzhasy"},{"id":"2","title":"\u0424\u0430\u043d\u0442\u0430\u0441\u0442\u0438\u043a\u0430","slug":"fantastika"},{"id":"3","title":"\u0411\u043e\u0435\u0432\u0438\u043a","slug":"boevik"},{"id":"4","title":"\u0422\u0440\u0438\u043b\u043b\u0435\u0440","slug":"triller"},{"id":"5","title":"\u0424\u044d\u043d\u0442\u0435\u0437\u0438","slug":"fentezi"},{"id":"6","title":"\u041a\u043e\u043c\u0435\u0434\u0438\u044f","slug":"komediia"},{"id":"7","title":"\u041c\u0435\u043b\u043e\u0434\u0440\u0430\u043c\u0430","slug":"melodrama"},{"id":"8","title":"\u0414\u0440\u0430\u043c\u0430","slug":"drama"},{"id":"9","title":"\u041c\u044e\u0437\u0438\u043a\u043b","slug":"miuzikl"},{"id":"10","title":"\u041f\u0440\u0438\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u044f","slug":"prikliucheniia"},{"id":"11","title":"\u0421\u0435\u043c\u0435\u0439\u043d\u044b\u0439","slug":"semeinyi"},{"id":"12","title":"\u0414\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u0430\u043b\u044c\u043d\u044b\u0439","slug":"dokumentalnyi"},{"id":"13","title":"\u0412\u0435\u0441\u0442\u0435\u0440\u043d","slug":"vestern"},{"id":"14","title":"\u041c\u0443\u043b\u044c\u0442\u0444\u0438\u043b\u044c\u043c","slug":"multfilm"},{"id":"15","title":"\u041a\u043e\u0440\u043e\u0442\u043a\u043e\u043c\u0435\u0442\u0440\u0430\u0436\u043a\u0430","slug":"korotkometrazhka"},{"id":"16","title":"\u041a\u0440\u0438\u043c\u0438\u043d\u0430\u043b","slug":"kriminal"},{"id":"17","title":"\u0414\u0435\u0442\u0435\u043a\u0442\u0438\u0432","slug":"detektiv"},{"id":"18","title":"\u0424\u0438\u043b\u044c\u043c-\u043d\u0443\u0430\u0440","slug":"film-nuar"},{"id":"19","title":"\u0412\u043e\u0435\u043d\u043d\u044b\u0439","slug":"voennyi"},{"id":"21","title":"\u041c\u0443\u0437\u044b\u043a\u0430","slug":"muzyka"},{"id":"22","title":"\u0411\u0438\u043e\u0433\u0440\u0430\u0444\u0438\u044f","slug":"biografiia"},{"id":"23","title":"\u0418\u0441\u0442\u043e\u0440\u0438\u044f","slug":"istoriia"},{"id":"24","title":"\u0421\u043f\u043e\u0440\u0442","slug":"sport"},{"id":"25","title":"\u0420\u0435\u0430\u043b\u044c\u043d\u043e\u0435 \u0422\u0412","slug":"realnoe-tv"},{"id":"26","title":"\u0422\u043e\u043a-\u0448\u043e\u0443","slug":"tok-shou"},{"id":"27","title":"\u0418\u0433\u0440\u0430","slug":"igra"},{"id":"28","title":"\u041d\u043e\u0432\u043e\u0441\u0442\u0438","slug":"novosti"},{"id":"456","title":"\u0414\u0435\u0442\u0441\u043a\u0438\u0439","slug":"detskii"},{"id":"1747","title":"\u041a\u043e\u043d\u0446\u0435\u0440\u0442","slug":"kontcert"},{"id":"1750","title":"\u0410\u043d\u0438\u043c\u0435","slug":"anime"}],"countries":[{"id":"1","title":"\u0421\u0428\u0410","slug":"ssha"},{"id":"2","title":"\u0420\u043e\u0441\u0441\u0438\u044f","slug":"rossiia"},{"id":"3","title":"\u0413\u0435\u0440\u043c\u0430\u043d\u0438\u044f","slug":"germaniia"},{"id":"4","title":"\u0414\u0430\u043d\u0438\u044f","slug":"daniia"},{"id":"5","title":"\u0428\u0432\u0435\u0446\u0438\u044f","slug":"shvetciia"},{"id":"6","title":"\u041a\u0430\u043d\u0430\u0434\u0430","slug":"kanada"},{"id":"7","title":"\u0424\u0438\u043d\u043b\u044f\u043d\u0434\u0438\u044f","slug":"finliandiia"},{"id":"8","title":"\u0424\u0440\u0430\u043d\u0446\u0438\u044f","slug":"frantciia"},{"id":"9","title":"\u042f\u043f\u043e\u043d\u0438\u044f","slug":"iaponiia"},{"id":"10","title":"\u0411\u0440\u0430\u0437\u0438\u043b\u0438\u044f","slug":"braziliia"},{"id":"11","title":"\u0412\u0435\u043b\u0438\u043a\u043e\u0431\u0440\u0438\u0442\u0430\u043d\u0438\u044f","slug":"velikobritaniia"},{"id":"12","title":"\u041d\u0438\u0434\u0435\u0440\u043b\u0430\u043d\u0434\u044b","slug":"niderlandy"},{"id":"14","title":"\u0418\u0442\u0430\u043b\u0438\u044f","slug":"italiia"},{"id":"15","title":"\u0418\u0441\u043f\u0430\u043d\u0438\u044f","slug":"ispaniia"},{"id":"17","title":"\u041c\u0435\u043a\u0441\u0438\u043a\u0430","slug":"meksika"},{"id":"20","title":"\u0410\u043b\u0436\u0438\u0440","slug":"alzhir"},{"id":"21","title":"\u0428\u0432\u0435\u0439\u0446\u0430\u0440\u0438\u044f","slug":"shveitcariia"},{"id":"22","title":"\u041c\u043e\u043d\u0430\u043a\u043e","slug":"monako"},{"id":"23","title":"\u041f\u0435\u0440\u0443","slug":"peru"},{"id":"24","title":"\u0410\u0440\u0433\u0435\u043d\u0442\u0438\u043d\u0430","slug":"argentina"},{"id":"25","title":"\u0410\u0432\u0441\u0442\u0440\u0430\u043b\u0438\u044f","slug":"avstraliia"},{"id":"26","title":"\u042e\u0436\u043d\u0430\u044f \u041a\u043e\u0440\u0435\u044f"},{"id":"27","title":"\u0422\u0430\u0439\u0432\u0430\u043d\u044c","slug":"taivan"},{"id":"28","title":"\u0413\u043e\u043d\u043a\u043e\u043d\u0433","slug":"gonkong"},{"id":"29","title":"\u0418\u043d\u0434\u0438\u044f","slug":"indiia"},{"id":"30","title":"\u042e\u0410\u0420","slug":"iuar"},{"id":"31","title":"\u041a\u0438\u0442\u0430\u0439","slug":"kitai"},{"id":"32","title":"\u041f\u043e\u043b\u044c\u0448\u0430","slug":"polsha"},{"id":"33","title":"\u041d\u043e\u0440\u0432\u0435\u0433\u0438\u044f","slug":"norvegiia"},{"id":"34","title":"\u0427\u0435\u0445\u0438\u044f","slug":"chekhiia"},{"id":"35","title":"\u041d\u043e\u0432\u0430\u044f \u0417\u0435\u043b\u0430\u043d\u0434\u0438\u044f","slug":"novaia-zelandiia"},{"id":"36","title":"\u041f\u043e\u0440\u0442\u0443\u0433\u0430\u043b\u0438\u044f","slug":"portugaliia"},{"id":"37","title":"\u0418\u0441\u043b\u0430\u043d\u0434\u0438\u044f","slug":"islandiia"},{"id":"38","title":"\u0418\u0440\u043b\u0430\u043d\u0434\u0438\u044f","slug":"irlandiia"},{"id":"39","title":"\u0411\u043e\u0441\u043d\u0438\u044f \u0438 \u0413\u0435\u0440\u0446\u0435\u0433\u043e\u0432\u0438\u043d\u0430","slug":"bosniia-i-gertcegovina"},{"id":"40","title":"\u0421\u043b\u043e\u0432\u0435\u043d\u0438\u044f","slug":"sloveniia"},{"id":"41","title":"\u0411\u0435\u043b\u044c\u0433\u0438\u044f","slug":"belgiia"},{"id":"42","title":"\u0418\u0437\u0440\u0430\u0438\u043b\u044c","slug":"izrail"},{"id":"43","title":"\u041c\u0430\u0440\u043e\u043a\u043a\u043e","slug":"marokko"},{"id":"44","title":"\u0422\u0430\u0438\u043b\u0430\u043d\u0434","slug":"tailand"},{"id":"45","title":"\u0421\u0438\u043d\u0433\u0430\u043f\u0443\u0440","slug":"singapur"},{"id":"46","title":"\u0420\u0443\u043c\u044b\u043d\u0438\u044f","slug":"rumyniia"},{"id":"47","title":"\u0424\u0438\u043b\u0438\u043f\u043f\u0438\u043d\u044b","slug":"filippiny"},{"id":"48","title":"\u0418\u0440\u0430\u043d","slug":"iran"},{"id":"49","title":"\u0412\u0435\u043d\u0433\u0440\u0438\u044f","slug":"vengriia"},{"id":"50","title":"\u0422\u0443\u043d\u0438\u0441","slug":"tunis"},{"id":"51","title":"\u0427\u0438\u043b\u0438","slug":"chili"},{"id":"52","title":"\u0412\u044c\u0435\u0442\u043d\u0430\u043c","slug":"vetnam"},{"id":"53","title":"\u042d\u0441\u0442\u043e\u043d\u0438\u044f","slug":"estoniia"},{"id":"54","title":"\u041b\u0430\u0442\u0432\u0438\u044f","slug":"latviia"},{"id":"55","title":"\u0413\u0440\u0435\u0446\u0438\u044f","slug":"gretciia"},{"id":"56","title":"\u041a\u043e\u043b\u0443\u043c\u0431\u0438\u044f","slug":"kolumbiia"},{"id":"57","title":"\u0410\u0432\u0441\u0442\u0440\u0438\u044f","slug":"avstriia"},{"id":"58","title":"\u041c\u043e\u043b\u0434\u043e\u0432\u0430","slug":"moldova"},{"id":"59","title":"\u041b\u044e\u043a\u0441\u0435\u043c\u0431\u0443\u0440\u0433","slug":"liuksemburg"},{"id":"61","title":"\u0413\u0440\u0443\u0437\u0438\u044f","slug":"gruziia"},{"id":"62","title":"\u0423\u043a\u0440\u0430\u0438\u043d\u0430","slug":"ukraina"},{"id":"63","title":"\u0411\u043e\u043b\u0433\u0430\u0440\u0438\u044f","slug":"bolgariia"},{"id":"64","title":"\u041a\u0438\u043f\u0440","slug":"kipr"},{"id":"65","title":"\u0421\u0435\u043d\u0435\u0433\u0430\u043b","slug":"senegal"},{"id":"67","title":"\u041c\u0430\u0432\u0440\u0438\u0442\u0430\u043d\u0438\u044f","slug":"mavritaniia"},{"id":"68","title":"\u0422\u0443\u0440\u0446\u0438\u044f","slug":"turtciia"},{"id":"69","title":"\u0411\u0435\u043b\u0430\u0440\u0443\u0441\u044c","slug":"belarus"},{"id":"70","title":"\u0422\u0430\u0434\u0436\u0438\u043a\u0438\u0441\u0442\u0430\u043d","slug":"tadzhikistan"},{"id":"71","title":"\u0423\u0437\u0431\u0435\u043a\u0438\u0441\u0442\u0430\u043d","slug":"uzbekistan"},{"id":"72","title":"\u0412\u0435\u043d\u0435\u0441\u0443\u044d\u043b\u0430","slug":"venesuela"},{"id":"73","title":"\u0418\u043d\u0434\u043e\u043d\u0435\u0437\u0438\u044f","slug":"indoneziia"},{"id":"74","title":"\u041f\u0430\u043a\u0438\u0441\u0442\u0430\u043d","slug":"pakistan"},{"id":"75","title":"\u0411\u0430\u043d\u0433\u043b\u0430\u0434\u0435\u0448","slug":"bangladesh"},{"id":"76","title":"\u041a\u0443\u0431\u0430","slug":"kuba"},{"id":"77","title":"\u0427\u0430\u0434"},{"id":"78","title":"\u041f\u0430\u043b\u0435\u0441\u0442\u0438\u043d\u0430","slug":"palestina"},{"id":"79","title":"\u0423\u0440\u0443\u0433\u0432\u0430\u0439","slug":"urugvai"},{"id":"80","title":"\u041c\u0430\u043a\u0435\u0434\u043e\u043d\u0438\u044f","slug":"makedoniia"},{"id":"81","title":"\u041c\u043e\u0437\u0430\u043c\u0431\u0438\u043a"},{"id":"82","title":"\u041f\u0443\u044d\u0440\u0442\u043e \u0420\u0438\u043a\u043e","slug":"puerto-riko"},{"id":"83","title":"\u041c\u0430\u043b\u0430\u0439\u0437\u0438\u044f","slug":"malaiziia"},{"id":"84","title":"\u041a\u0430\u043c\u0431\u043e\u0434\u0436\u0430","slug":"kambodzha"},{"id":"85","title":"\u0425\u043e\u0440\u0432\u0430\u0442\u0438\u044f","slug":"khorvatiia"},{"id":"86","title":"\u041a\u044b\u0440\u0433\u044b\u0437\u0441\u0442\u0430\u043d","slug":"kyrgyzstan"},{"id":"87","title":"\u042d\u0440\u0438\u0442\u0440\u0435\u044f"},{"id":"88","title":"\u0422\u0440\u0438\u043d\u0438\u0434\u0430\u0434 \u0438 \u0422\u043e\u0431\u0430\u0433\u043e","slug":"trinidad-i-tobago"},{"id":"89","title":"\u0410\u0440\u043c\u0435\u043d\u0438\u044f","slug":"armeniia"},{"id":"90","title":"\u0418\u0440\u0430\u043a","slug":"irak"},{"id":"91","title":"\u041d\u0430\u043c\u0438\u0431\u0438\u044f","slug":"namibiia"},{"id":"92","title":"\u0411\u0443\u0440\u043a\u0438\u043d\u0430-\u0424\u0430\u0441\u043e","slug":"burkina-faso"},{"id":"93","title":"\u042f\u043c\u0430\u0439\u043a\u0430","slug":"iamaika"},{"id":"94","title":"\u0421\u043b\u043e\u0432\u0430\u043a\u0438\u044f","slug":"slovakiia"},{"id":"95","title":"\u041a\u0430\u043c\u0435\u0440\u0443\u043d","slug":"kamerun"},{"id":"96","title":"\u042d\u043a\u0432\u0430\u0434\u043e\u0440","slug":"ekvador"},{"id":"97","title":"\u041b\u0438\u0432\u0430\u043d","slug":"livan"},{"id":"98","title":"\u0421\u0438\u0440\u0438\u044f","slug":"siriia"},{"id":"99","title":"\u0413\u0430\u0438\u0442\u0438","slug":"gaiti"},{"id":"100","title":"\u041a\u0435\u043d\u0438\u044f","slug":"keniia"},{"id":"101","title":"\u0415\u0433\u0438\u043f\u0435\u0442","slug":"egipet"},{"id":"102","title":"\u041c\u0430\u0440\u0442\u0438\u043d\u0438\u043a\u0430"},{"id":"103","title":"\u0420\u0443\u0430\u043d\u0434\u0430","slug":"ruanda"},{"id":"104","title":"\u0417\u0438\u043c\u0431\u0430\u0431\u0432\u0435","slug":"zimbabve"},{"id":"105","title":"\u0411\u0430\u0440\u0431\u0430\u0434\u043e\u0441","slug":"barbados"},{"id":"106","title":"\u041d\u0435\u043f\u0430\u043b","slug":"nepal"},{"id":"107","title":"\u041f\u0430\u043d\u0430\u043c\u0430","slug":"panama"},{"id":"108","title":"\u0428\u0440\u0438-\u041b\u0430\u043d\u043a\u0430","slug":"shri-lanka"},{"id":"110","title":"\u041d\u0438\u0433\u0435\u0440\u0438\u044f","slug":"nigeriia"},{"id":"111","title":"\u041c\u0430\u043b\u044c\u0442\u0430","slug":"malta"},{"id":"112","title":"\u0413\u043e\u043d\u0434\u0443\u0440\u0430\u0441","slug":"gonduras"},{"id":"113","title":"\u0410\u0444\u0433\u0430\u043d\u0438\u0441\u0442\u0430\u043d","slug":"afganistan"},{"id":"114","title":"\u0411\u0443\u0442\u0430\u043d","slug":"butan"},{"id":"115","title":"\u041c\u0430\u0432\u0440\u0438\u043a\u0438\u0439","slug":"mavrikii"},{"id":"116","title":"\u0413\u0432\u0438\u043d\u0435\u044f-\u0411\u0438\u0441\u0430\u0443"},{"id":"117","title":"\u0413\u0440\u0435\u043d\u043b\u0430\u043d\u0434\u0438\u044f","slug":"grenlandiia"},{"id":"118","title":"\u0411\u043e\u043b\u0438\u0432\u0438\u044f","slug":"boliviia"},{"id":"119","title":"\u041e\u0410\u042d","slug":"oae"},{"id":"120","title":"\u0410\u043b\u0431\u0430\u043d\u0438\u044f","slug":"albaniia"},{"id":"121","title":"\u0421\u0430\u043b\u044c\u0432\u0430\u0434\u043e\u0440","slug":"salvador"},{"id":"122","title":"\u041a\u0430\u0437\u0430\u0445\u0441\u0442\u0430\u043d","slug":"kazakhstan"},{"id":"123","title":"\u041b\u0438\u0442\u0432\u0430","slug":"litva"},{"id":"124","title":"\u0411\u0430\u0433\u0430\u043c\u044b"},{"id":"125","title":"\u041b\u0438\u0445\u0442\u0435\u043d\u0448\u0442\u0435\u0439\u043d","slug":"likhtenshtein"},{"id":"126","title":"\u041b\u0438\u0432\u0438\u044f","slug":"liviia"},{"id":"127","title":"\u0413\u0430\u0431\u043e\u043d"},{"id":"128","title":"\u0414\u043e\u043c\u0438\u043d\u0438\u043a\u0430\u043d\u0430","slug":"dominikana"},{"id":"129","title":"\u0413\u0432\u0438\u043d\u0435\u044f"},{"id":"130","title":"\u0422\u0430\u043d\u0437\u0430\u043d\u0438\u044f"},{"id":"131","title":"\u041a\u043e\u0441\u0442\u0430-\u0420\u0438\u043a\u0430","slug":"kosta-rika"},{"id":"132","title":"\u041c\u043e\u043d\u0433\u043e\u043b\u0438\u044f","slug":"mongoliia"},{"id":"133","title":"\u0417\u0430\u043c\u0431\u0438\u044f","slug":"zambiia"},{"id":"134","title":"\u041a\u043e\u043d\u0433\u043e","slug":"kongo"},{"id":"135","title":"\u0413\u0432\u0430\u0442\u0435\u043c\u0430\u043b\u0430","slug":"gvatemala"},{"id":"136","title":"\u0410\u0437\u0435\u0440\u0431\u0430\u0439\u0434\u0436\u0430\u043d","slug":"azerbaidzhan"},{"id":"137","title":"\u041a\u043e\u0440\u0435\u044f \u0421\u0435\u0432\u0435\u0440\u043d\u0430\u044f","slug":"koreia-severnaia"},{"id":"138","title":"\u041d\u0438\u043a\u0430\u0440\u0430\u0433\u0443\u0430","slug":"nikaragua"},{"id":"139","title":"\u0410\u043d\u0433\u043e\u043b\u0430","slug":"angola"},{"id":"140","title":"\u0411\u0435\u043d\u0438\u043d"},{"id":"141","title":"\u0426\u0410\u0420"},{"id":"142","title":"\u0413\u0443\u0430\u0434\u0435\u043b\u0443\u043f\u0430"},{"id":"143","title":"\u041f\u0430\u0440\u0430\u0433\u0432\u0430\u0439","slug":"paragvai"},{"id":"144","title":"\u0413\u0430\u043d\u0430","slug":"gana"},{"id":"145","title":"\u0411\u043e\u0442\u0441\u0432\u0430\u043d\u0430","slug":"botsvana"},{"id":"146","title":"\u041a\u0430\u0431\u043e-\u0412\u0435\u0440\u0434\u0435"},{"id":"147","title":"\u041a\u0443\u0432\u0435\u0439\u0442","slug":"kuveit"},{"id":"149","title":"\u041b\u0430\u043e\u0441","slug":"laos"},{"id":"150","title":"\u041c\u0430\u0434\u0430\u0433\u0430\u0441\u043a\u0430\u0440","slug":"madagaskar"},{"id":"151","title":"\u041c\u0430\u043b\u0438"},{"id":"152","title":"\u0422\u0443\u0440\u043a\u043c\u0435\u043d\u0438\u0441\u0442\u0430\u043d","slug":"turkmenistan"},{"id":"153","title":"\u041c\u0430\u043a\u0430\u043e","slug":"makao"},{"id":"154","title":"\u0418\u043e\u0440\u0434\u0430\u043d\u0438\u044f","slug":"iordaniia"},{"id":"157","title":"\u041d\u0438\u0433\u0435\u0440"},{"id":"158","title":"\u0421\u0430\u0443\u0434\u043e\u0432\u0441\u043a\u0430\u044f \u0410\u0440\u0430\u0432\u0438\u044f","slug":"saudovskaia-araviia"},{"id":"159","title":"\u0410\u043d\u0434\u043e\u0440\u0440\u0430","slug":"andorra"},{"id":"160","title":"\u0421\u043e\u043c\u0430\u043b\u0438"},{"id":"161","title":"\u0422\u043e\u0433\u043e"},{"id":"162","title":"\u0411\u0443\u0440\u0443\u043d\u0434\u0438"},{"id":"163","title":"\u041f\u0430\u043f\u0443\u0430 - \u041d\u043e\u0432\u0430\u044f \u0413\u0432\u0438\u043d\u0435\u044f","slug":"papua---novaia-gvineia"},{"id":"164","title":"\u0411\u0430\u0445\u0440\u0435\u0439\u043d","slug":"bakhrein"},{"id":"165","title":"\u0413\u0430\u0439\u0430\u043d\u0430"},{"id":"166","title":"\u0424\u0438\u0434\u0436\u0438","slug":"fidzhi"},{"id":"167","title":"\u0421\u0443\u0434\u0430\u043d"},{"id":"168","title":"\u042d\u0444\u0438\u043e\u043f\u0438\u044f","slug":"efiopiia"},{"id":"169","title":"\u0419\u0435\u043c\u0435\u043d","slug":"iemen"},{"id":"171","title":"\u0421\u0443\u0440\u0438\u043d\u0430\u043c"},{"id":"172","title":"\u0423\u0433\u0430\u043d\u0434\u0430"},{"id":"173","title":"\u0411\u0435\u043b\u0438\u0437","slug":"beliz"},{"id":"175","title":"\u0410\u0440\u0443\u0431\u0430","slug":"aruba"},{"id":"176","title":"\u041b\u0438\u0431\u0435\u0440\u0438\u044f","slug":"liberiia"},{"id":"177","title":"\u0421\u0435\u0440\u0431\u0438\u044f","slug":"serbiia"},{"id":"178","title":"\u0411\u043e\u0441\u043d\u0438\u044f","slug":"bosniia"},{"id":"1002","title":"\u041a\u0430\u0442\u0430\u0440","slug":"katar"},{"id":"1003","title":"\u041e\u043c\u0430\u043d"},{"id":"1004","title":"\u0411\u0435\u0440\u043c\u0443\u0434\u044b","slug":"bermudy"},{"id":"1006","title":"\u041d\u043e\u0432\u0430\u044f \u041a\u0430\u043b\u0435\u0434\u043e\u043d\u0438\u044f","slug":"novaia-kaledoniia"},{"id":"1007","title":"\u041e\u0441\u0442\u0440\u043e\u0432\u0430 \u0422\u0435\u0440\u043a\u0441 \u0438 \u041a\u0430\u0439\u043a\u043e\u0441"},{"id":"1008","title":"\u0424\u0430\u0440\u0435\u0440\u0441\u043a\u0438\u0435 \u043e\u0441\u0442\u0440\u043e\u0432\u0430","slug":"farerskie-ostrova"},{"id":"1009","title":"\u0410\u043d\u0442\u0438\u043b\u044c\u0441\u043a\u0438\u0435 \u041e\u0441\u0442\u0440\u043e\u0432\u0430","slug":"antilskie-ostrova"},{"id":"1010","title":"\u0421\u0435\u0439\u0448\u0435\u043b\u044c\u0441\u043a\u0438\u0435 \u043e\u0441\u0442\u0440\u043e\u0432\u0430"},{"id":"1011","title":"\u0421\u0430\u043d-\u041c\u0430\u0440\u0438\u043d\u043e"},{"id":"1012","title":"\u0422\u043e\u043d\u0433\u0430"},{"id":"1013","title":"\u041a\u043e\u0441\u043e\u0432\u043e","slug":"kosovo"},{"id":"1014","title":"\u041a\u043e\u043d\u0433\u043e (\u0414\u0420\u041a)","slug":"kongo--drk"},{"id":"1015","title":"\u041b\u0435\u0441\u043e\u0442\u043e"},{"id":"1020","title":"\u0427\u0435\u0440\u043d\u043e\u0433\u043e\u0440\u0438\u044f","slug":"chernogoriia"},{"id":"1022","title":"\u0413\u0438\u0431\u0440\u0430\u043b\u0442\u0430\u0440"},{"id":"1023","title":"\u0421\u044c\u0435\u0440\u0440\u0430-\u041b\u0435\u043e\u043d\u0435"},{"id":"1024","title":"\u041a\u0438\u0440\u0438\u0431\u0430\u0442\u0438"},{"id":"1025","title":"\u041c\u0430\u043b\u0430\u0432\u0438","slug":"malavi"},{"id":"1026","title":"\u0410\u043c\u0435\u0440\u0438\u043a\u0430\u043d\u0441\u043a\u0438\u0435 \u0412\u0438\u0440\u0433\u0438\u043d\u0441\u043a\u0438\u0435 \u043e\u0441\u0442\u0440\u043e\u0432\u0430"},{"id":"1028","title":"\u0414\u0436\u0438\u0431\u0443\u0442\u0438"},{"id":"1029","title":"\u0421\u0432\u0430\u0437\u0438\u043b\u0435\u043d\u0434"},{"id":"1030","title":"\u0410\u043d\u0442\u0438\u0433\u0443\u0430 \u0438 \u0411\u0430\u0440\u0431\u0443\u0434\u0430"},{"id":"1031","title":"\u0414\u043e\u043c\u0438\u043d\u0438\u043a\u0430"},{"id":"1032","title":"\u0424\u0440\u0430\u043d\u0446\u0443\u0437\u0441\u043a\u0430\u044f \u0413\u0432\u0438\u0430\u043d\u0430"},{"id":"1034","title":"\u041c\u044c\u044f\u043d\u043c\u0430","slug":"mianma"},{"id":"1036","title":"\u0420\u0435\u044e\u043d\u044c\u043e\u043d","slug":"reiunon"},{"id":"1038","title":"\u0424\u0435\u0434\u0435\u0440\u0430\u0442\u0438\u0432\u043d\u044b\u0435 \u0428\u0442\u0430\u0442\u044b \u041c\u0438\u043a\u0440\u043e\u043d\u0435\u0437\u0438\u0438"},{"id":"1039","title":"\u0421\u0430\u043c\u043e\u0430"},{"id":"1040","title":"\u0413\u0430\u043c\u0431\u0438\u044f","slug":"gambiia"},{"id":"1043","title":"\u0417\u0430\u043f\u0430\u0434\u043d\u0430\u044f \u0421\u0430\u0445\u0430\u0440\u0430"},{"id":"1044","title":"\u0410\u043d\u0442\u0430\u0440\u043a\u0442\u0438\u0434\u0430"},{"id":"1045","title":"\u0413\u0443\u0430\u043c"},{"id":"1046","title":"\u0424\u0440\u0430\u043d\u0446\u0443\u0437\u0441\u043a\u0430\u044f \u041f\u043e\u043b\u0438\u043d\u0435\u0437\u0438\u044f","slug":"frantcuzskaia-polineziia"},{"id":"1047","title":"\u041e\u0441\u0442\u0440\u043e\u0432 \u0421\u0432\u044f\u0442\u043e\u0439 \u0415\u043b\u0435\u043d\u044b"},{"id":"1049","title":"\u0421\u0435\u043d\u0442-\u041b\u044e\u0441\u0438\u044f"},{"id":"1050","title":"\u041c\u0430\u043b\u044c\u0434\u0438\u0432\u044b"},{"id":"1051","title":"\u041a\u0430\u0439\u043c\u0430\u043d\u043e\u0432\u044b \u043e\u0441\u0442\u0440\u043e\u0432\u0430","slug":"kaimanovy-ostrova"},{"id":"1052","title":"\u041e\u0441\u0442\u0440\u043e\u0432 \u041c\u044d\u043d","slug":"ostrov-men"},{"id":"1053","title":"\u0422\u0443\u0432\u0430\u043b\u0443"},{"id":"1055","title":"\u0421\u0435\u043d\u0442-\u0412\u0438\u043d\u0441\u0435\u043d\u0442 \u0438 \u0413\u0440\u0435\u043d\u0430\u0434\u0438\u043d\u044b"},{"id":"1057","title":"\u041f\u0430\u043b\u0430\u0443"},{"id":"1058","title":"\u041a\u043e\u043c\u043e\u0440\u044b"},{"id":"1059","title":"\u0412\u0430\u043d\u0443\u0430\u0442\u0443","slug":"vanuatu"},{"id":"1060","title":"\u0413\u0440\u0435\u043d\u0430\u0434\u0430"},{"id":"1061","title":"\u042d\u043a\u0432\u0430\u0442\u043e\u0440\u0438\u0430\u043b\u044c\u043d\u0430\u044f \u0413\u0432\u0438\u043d\u0435\u044f"},{"id":"1062","title":"\u0410\u043c\u0435\u0440\u0438\u043a\u0430\u043d\u0441\u043a\u043e\u0435 \u0421\u0430\u043c\u043e\u0430"},{"id":"1063","title":"\u041e\u0441\u0442\u0440\u043e\u0432\u0430 \u041a\u0443\u043a\u0430"},{"id":"1064","title":"\u0412\u043d\u0435\u0448\u043d\u0438\u0435 \u043c\u0430\u043b\u044b\u0435 \u043e\u0441\u0442\u0440\u043e\u0432\u0430 \u0421\u0428\u0410"},{"id":"1065","title":"\u041c\u043e\u043d\u0442\u0441\u0435\u0440\u0440\u0430\u0442"},{"id":"1066","title":"\u0411\u0440\u0443\u043d\u0435\u0439-\u0414\u0430\u0440\u0443\u0441\u0441\u0430\u043b\u0430\u043c"},{"id":"1067","title":"\u041c\u0430\u0440\u0448\u0430\u043b\u043b\u043e\u0432\u044b \u043e\u0441\u0442\u0440\u043e\u0432\u0430"},{"id":"1068","title":"\u0422\u0438\u043c\u043e\u0440-\u041b\u0435\u0441\u0442\u0435"},{"id":"1069","title":"\u0421\u043e\u043b\u043e\u043c\u043e\u043d\u043e\u0432\u044b \u041e\u0441\u0442\u0440\u043e\u0432\u0430"},{"id":"1071","title":"\u0421\u0435\u043d\u0442-\u041a\u0438\u0442\u0441 \u0438 \u041d\u0435\u0432\u0438\u0441","slug":"sent-kits-i-nevis"},{"id":"1074","title":"\u041a\u043e\u0442-\u0434\u2019\u0418\u0432\u0443\u0430\u0440","slug":"kot-d-ivuar"},{"id":"1075","title":"\u0424\u043e\u043b\u043a\u043b\u0435\u043d\u0434\u0441\u043a\u0438\u0435 \u043e\u0441\u0442\u0440\u043e\u0432\u0430"},{"id":"1076","title":"\u0412\u0430\u0442\u0438\u043a\u0430\u043d","slug":"vatikan"},{"id":"1077","title":"\u0412\u0438\u0440\u0433\u0438\u043d\u0441\u043a\u0438\u0435 \u041e\u0441\u0442\u0440\u043e\u0432\u0430"},{"id":"1078","title":"\u0421\u0435\u0432\u0435\u0440\u043d\u0430\u044f \u041c\u0430\u043a\u0435\u0434\u043e\u043d\u0438\u044f","slug":"severnaia-makedoniia"}]};
var own = Object.prototype.hasOwnProperty;
function array(value) { return Object.prototype.toString.call(value) === '[object Array]' ? value : []; }
function text(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.ru || value.original || value.en || value.uk || '';
}
function id(value) { var s = String(value === undefined ? '' : value); return /^[1-9][0-9]{0,11}$/.test(s) ? s : null; }
function kind(entity) { return entity && entity._type === 'Movie' ? 'movie' : entity && entity._type === 'Serial' ? 'series' : null; }
function failure(message, status) { var e = new Error(message); e.statusCode = status || 502; return e; }
function integer(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  var n = Number(value); return isFinite(n) && n % 1 === 0 && n >= min && n <= max ? n : null;
}
function image(value, type, width) {
  var n = id(value); if (!n) return '';
  return 'https://img' + (Number(n) % 4 + 1) + '.zonapic.com/images/' + type +
    (width ? '_' + width : '') + '/' + Math.floor(Number(n) / 1000) + '/' + n + '.jpg';
}
function date(value) {
  if (typeof value === 'number' && isFinite(value)) { var d = new Date(value); return isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null; }
  return null;
}
function rating(entity, source) {
  var n = entity && entity.ratings && entity.ratings[source] && entity.ratings[source].value;
  return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 10 ? n : 0;
}
function names(values) { return array(values).map(function (p) { return text(p && p.name); }).filter(Boolean).join(', '); }
function slug(entity) { var n = id(entity && entity.id), t = kind(entity); return n && t ? 'android-' + t + '-' + n : null; }
function rewriteLegacy(value, expected) {
  var nodes = 0;
  function walk(input, type, depth) {
    if (!input || typeof input !== 'object') return input;
    if (++nodes > 6000 || depth > 14) throw failure('Legacy metadata rewrite limit', 502);
    if (Array.isArray(input)) return input.map(function (item) { return walk(item, type, depth + 1); });
    var output = {}, inferred = input.type === 'series' || input.type === 'movie' ? input.type : type;
    if (Array.isArray(input.seasons)) inferred = 'series';
    Object.keys(input).forEach(function (key) { output[key] = walk(input[key], inferred, depth + 1); });
    var kpId = id(input.kp_id);
    if (kpId && typeof input.slug === 'string' && typeof input.title === 'string' && (inferred === 'movie' || inferred === 'series')) {
      output.slug = 'android-' + inferred + '-' + kpId;
    }
    return output;
  }
  return walk(value, expected, 0);
}
function card(entity) {
  var s = slug(entity); if (!s || !text(entity.name)) return null;
  var t = kind(entity), backdrop = id(entity.backdropId);
  return { slug: s, type: t, title: text(entity.name), title_original: entity.name && entity.name.original || '', title_eng: entity.name && entity.name.en || null,
    description: text(entity.description), cover_url: image(entity.id, 'film', 240), backdrop_url: backdrop ? image(backdrop, 'backdrop', 1920) : null,
    backdrop_id: backdrop ? Number(backdrop) : null, age_limit: integer(entity.minAge, 0, 0, 21) || 0, year: integer(entity.year, 0, 0, 9999) || 0,
    rating: rating(entity, 'zona') || rating(entity, 'kinopoisk') || rating(entity, 'imdb'), rating_kp: rating(entity, 'kinopoisk'), rating_imdb: rating(entity, 'imdb'),
    rating_count: 0, duration: Number(entity.runtime) || 0, directors: names(entity.directors), writers: names(entity.writers), kp_id: Number(entity.id),
    release_date: date(entity.releaseDateInt), release_date_ru: date(entity.releaseDateRus), is_trailer: false };
}
function create(options) {
  options = options || {};
  var native = options.native;
  if (!native || typeof native.request !== 'function') throw new TypeError('Native metadata client required');
  var dictionary = options.dictionary || DEFAULT_DICTIONARY;
  var clock = options.now || Date.now, limit = 128, bytesLimit = 2 * 1024 * 1024;
  var later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  var cache = Object.create(null), order = [], bytes = 0, pending = Object.create(null), active = 0, queue = [];
  var concurrency = integer(options.concurrency, 6, 1, 8) || 6;
  function cached(key) {
    var item = cache[key]; if (!item) return null;
    if (item.until < clock()) { remove(key); return null; }
    var p = order.indexOf(key); if (p >= 0) order.splice(p, 1); order.push(key);
    return item.value;
  }
  function remove(key) { if (!cache[key]) return; bytes -= cache[key].bytes; delete cache[key]; var p = order.indexOf(key); if (p >= 0) order.splice(p, 1); }
  function put(key, value, ttl) {
    var size = Buffer.byteLength(JSON.stringify(value), 'utf8'); if (size > bytesLimit / 2) return;
    remove(key); while (order.length && (order.length >= limit || bytes + size > bytesLimit)) remove(order[0]);
    cache[key] = { value: value, bytes: size, until: clock() + ttl }; order.push(key); bytes += size;
  }
  function pump() {
    while (active < concurrency && queue.length) {
      var job = queue.shift(); active++;
      (function (work) {
        var done = false;
        function finish(error, value) {
          if (done) return; done = true; active--;
          var callbacks = pending[work.key] || []; delete pending[work.key];
          if (!error && value) put(work.key, value, work.ttl);
          callbacks.forEach(function (cb) { cb(error, value); }); pump();
        }
        try { native.request(work.path, work.params, finish); } catch (e) { finish(e); }
      }(job));
    }
  }
  function request(path, params, callback, ttl) {
    var key = path + ':' + JSON.stringify(params), hit = cached(key);
    if (hit) return callback(null, hit);
    if (pending[key]) { if (pending[key].length >= 16) return callback(failure('Metadata waiter limit', 503)); pending[key].push(callback); return; }
    if (queue.length >= 160) return callback(failure('Metadata queue limit', 503));
    pending[key] = [callback]; queue.push({key: key, path: path, params: params, ttl: ttl || 120000}); pump();
  }
  function entity(entityId, occupancy, expected, callback) {
    request('/getMovieOrSerialById', {id: entityId, occupancy: occupancy, installerPackage: ''}, function (error, value) {
      if (error) return callback(error);
      var found = array(value && value.data).filter(function (v) { return id(v && v.id) === entityId; })[0];
      if (!found || !kind(found) || expected && kind(found) !== expected) return callback(failure('Native entity identity mismatch', 404));
      callback(null, found);
    });
  }
  function entities(ids, expected, callback) {
    ids = array(ids).slice(0, 20).map(id).filter(Boolean);
    if (!ids.length) return callback(null, []);
    var remaining = ids.length, results = new Array(ids.length), firstError = null;
    ids.forEach(function (entityId, index) {
      entity(entityId, 'Lite', expected, function (error, value) {
        if (error) firstError = firstError || error;
        else results[index] = card(value);
        if (--remaining === 0) {
          var valid = results.filter(Boolean);
          // A transient failed entity must not silently shorten a page and make
          // the UI believe the complete page was successfully loaded.
          callback(firstError, valid);
        }
      });
    });
  }
  function tags(values, entries, type) {
    return array(values).map(function (n) {
      var match = array(entries).filter(function (x) { return String(x.id) === String(n); })[0];
      return match ? {slug: match.slug || 'android:' + match.id, title: match.title, type: type, cover_url: ''} : null;
    }).filter(Boolean);
  }
  function details(entityId, expected, season, callback) {
    entity(entityId, 'Full', expected, function (error, value) {
      if (error) return callback(error);
      var result = card(value); if (!result) return callback(failure('Invalid native entity', 502));
      result.end_year = Number(value.yearEnd) || 0; result.series_ended = !!value.yearEnd;
      result.statuses = {dmca: false, memorandum: false};
      result.meta = {id: Number(entityId), media_id: null, embed_url: null, actors: array(value.actors).map(function (a) {
        return {name: text(a.name), cover_url: image(a.id, 'actor'), role: ''};
      }), tags: tags(value.genreIds, dictionary.genres, 'genre').concat(tags(value.countryIds, dictionary.countries, 'country')), sequels: [], relations: []};
      function finish() {
        var relatedIds = [], seen = Object.create(null);
        array(value.rels).forEach(function (row) {
          var related = id(row && row.rmi);
          if (related && related !== entityId && !seen[related] && relatedIds.length < 8) { seen[related] = true; relatedIds.push(related); }
        });
        if (!relatedIds.length) return callback(null, {data: result, seo: {h1: result.title}});
        var delivered = false;
        var relatedTimer = later(function () { deliver(new Error('Related metadata deadline'), []); }, 1200);
        function deliver(relatedError, related) {
          if (delivered) return;
          delivered = true;
          cancel(relatedTimer);
          result.meta.relations = related || [];
          if (relatedError) result.meta.relations_status = 'unavailable';
          callback(null, {data: result, seo: {h1: result.title}});
        }
        entities(relatedIds, null, function (relatedError, related) {
          // Recommendations are optional. Their outage cannot remove a valid
          // primary card or exceed the portal's ten-second request deadline.
          // Late lookups can populate the bounded cache, never settle twice.
          deliver(relatedError, related);
        });
      }
      if (expected !== 'series') return finish();
      var episodeKeys = array(value.episodes), seasons = Object.create(null), keys = Object.create(null), n;
      episodeKeys.forEach(function (key) {
        var m = typeof key === 'string' && /^S([0-9]{1,4})E([0-9]{1,5})$/.exec(key);
        if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) return;
        var sn = Number(m[1]), en = Number(m[2]), identity = sn + ':' + en;
        if (keys[identity]) return;
        keys[identity] = key;
        if (!seasons[sn]) seasons[sn] = {slug: String(sn), part: sn, episode_count: 0, is_banned: false};
        seasons[sn].episode_count++;
      });
      result.seasons = Object.keys(seasons).map(function (key) { return seasons[key]; }).sort(function (a, b) { return a.part - b.part; });
      // A valid series may not publish season one (or any episodes yet). Only
      // an explicitly requested unavailable season is a missing resource.
      if (season === null) {
        if (!result.seasons.length) { result.episodes = []; return finish(); }
        season = result.seasons[0].part;
      }
      if (!own.call(seasons, String(season))) return callback(failure('Native season is unavailable', 404));
      request('/getEpisodes', {entityId: Number(entityId)}, function (episodeError, response) {
        if (episodeError) return callback(episodeError);
        var metadata = Object.create(null);
        array(response && response.data).forEach(function (row) {
          var sn = row && row.num && row.num.season, en = row && row.num && row.num.episode;
          if (integer(sn, null, 1, 9999) === null || integer(en, null, 1, 99999) === null) return;
          metadata[sn + ':' + en] = row;
        });
        result.episodes = Object.keys(keys).filter(function (key) { return Number(key.split(':')[0]) === season; }).map(function (key) {
          var en = Number(key.split(':')[1]), row = metadata[key] || {};
          return {slug: String(en), part: en, title: text(row.title) || 'Серия ' + en, title_original: row.title && row.title.original || '',
            description: text(row.description), cover_url: '', duration: 0, release_date: date(row.releaseDate), is_banned: false,
            meta: {id: null, media_id: null, episodeKey: keys[key]}};
        }).sort(function (a, b) { return a.part - b.part; });
        finish();
      });
    });
  }
  function filterId(value, entries) {
    if (value === undefined || value === '') return '';
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    var raw = String(value), nativeMatch = /^android:([a-z0-9]{1,8})$/.exec(raw);
    if (nativeMatch) return array(entries).some(function (x) { return String(x.id) === nativeMatch[1]; }) ? nativeMatch[1] : null;
    var found = array(entries).filter(function (x) { return x.slug === raw; })[0];
    return found ? String(found.id) : null;
  }
  function makeFilter(query, callback) {
    var genre = filterId(query.genre, dictionary.genres), country = filterId(query.country, dictionary.countries);
    if (genre === null || country === null) return callback(failure('Unsupported native genre/country filter', 400));
    var filter = {movieSourceTypes: array(native.sourceTypes), genres: genre, countries: country};
    var mappings = {year_from: ['yearFrom', 0, 9999], year_to: ['yearTo', 0, 9999], rating_from: ['ratingFrom', 0, 10], rating_to: ['ratingTo', 0, 10]};
    for (var k in mappings) if (own.call(mappings, k) && query[k] !== undefined && query[k] !== '') {
      var spec = mappings[k], number = Number(query[k]);
      if (typeof query[k] === 'object' || !isFinite(number) || number < spec[1] || number > spec[2] || spec[0].indexOf('year') === 0 && number % 1) return callback(failure('Invalid native filter', 400));
      filter[spec[0]] = number;
    }
    if (query.year) {
      var year = String(query.year), decade = /^(\d{4})s$/.exec(year), short = /^(\d{2})s$/.exec(year);
      if (/^\d{4}$/.test(year)) filter.yearFrom = filter.yearTo = Number(year);
      else if (decade) { filter.yearFrom = Number(decade[1]); filter.yearTo = filter.yearFrom + 9; }
      else if (short) { filter.yearFrom = 1900 + Number(short[1]); filter.yearTo = filter.yearFrom + 9; }
      else if (year === 'old') { filter.yearTo = 1939; }
      else return callback(failure('Invalid native year', 400));
    }
    if (query.rating) { var r = Number(query.rating); if (!isFinite(r) || r < 0 || r > 10) return callback(failure('Invalid native rating', 400)); filter.ratingFrom = r; }
    var sort = query.sort || 'popularity';
    if (sort !== 'popularity' && sort !== 'rating' && sort !== 'date' && sort !== 'release_date') return callback(failure('Unsupported native sort', 400));
    filter.sortBy = sort === 'date' ? 'release_date' : sort;
    callback(null, filter);
  }
  function listing(expected, query, path, callback, collection) {
    var page = integer(query.page, 1, 1, 1000000); if (page === null) return callback(failure('Invalid native page', 400));
    makeFilter(query, function (error, filter) {
      if (error) return callback(error);
      var perPage = 20, offset = (page - 1) * perPage;
      request(expected === 'series' ? '/getSerialIds' : '/getMovieIds', {page: {limit: perPage, offset: offset}, filter: filter, installerPackage: ''}, function (error, result) {
        if (error) return callback(error);
        if (!result || !Array.isArray(result.data) || !isFinite(Number(result.total))) return callback(failure('Invalid native catalog page', 502));
        entities(result.data, expected, function (error, values) {
          if (error) return callback(error);
          if (collection) return callback(null, {data: {title: collection, entities: values}});
          var total = Math.max(0, Number(result.total)), last = Math.max(1, Math.ceil(total / perPage));
          function link(n) { return path + '?page=' + n; }
          callback(null, {data: values, links: {first: link(1), last: link(last), prev: page > 1 ? link(page - 1) : null, next: page < last ? link(page + 1) : null},
            meta: {current_page: page, per_page: perPage, last_page: last, total: total}, seo: {h1: expected === 'series' ? 'Сериалы' : 'Фильмы'}});
        });
      }, 60000);
    });
  }
  function search(query, suggest, callback) {
    var q = query.query;
    if (typeof q !== 'string' || q.length > 200) return callback(failure('Invalid search query', 400));
    q = q.trim(); if (!q) return callback(null, {data: []});
    var cap = suggest ? integer(query.limit, 5, 1, 20) : 100;
    if (cap === null) return callback(failure('Invalid suggestion limit', 400));
    request('/search', {query: q, movieSourceTypes: array(native.sourceTypes), pageParams: {limit: 200, offset: 0}, hideUnavailable: true, installerPackage: ''}, function (error, response) {
      if (error) return callback(error);
      if (!response || !Array.isArray(response.data)) return callback(failure('Invalid native search response', 502));
      var values = response.data.map(card).filter(Boolean).slice(0, cap);
      callback(null, {data: values});
    }, 30000);
  }
  function references() {
    var years = [], n, current = new Date(clock()).getUTCFullYear();
    for (n = current; n >= 1940; n--) years.push({title: String(n), value: String(n)});
    function refs(entries) { return array(entries).map(function (x) { return {title: x.title, value: 'android:' + x.id}; }); }
    return {sort: [{title: 'По популярности', value: ''}, {title: 'По рейтингу', value: 'rating'}, {title: 'По дате выхода', value: 'date'}],
      rating: [9, 8, 7, 6, 5, 4, 3, 2, 1].map(function (n) { return {title: 'от ' + n, value: n}; }), year: years, genres: refs(dictionary.genres), countries: refs(dictionary.countries), studio: []};
  }
  function handle(pathname, query, callback) {
    query = query || {};
    if (pathname === '/search' || pathname === '/suggest') { search(query, pathname === '/suggest', callback); return true; }
    if (pathname === '/api/assist/references') { callback(null, references()); return true; }
    var m = /^\/api\/(movies|series)(?:\/filter)?$/.exec(pathname);
    if (m) {
      // These web-only editorial controls have no equivalent in Android Filter.
      // Their route remains explicit for the service's preserved web fallback.
      if (query.studio || query.sort === 'last') return false;
      listing(m[1] === 'series' ? 'series' : 'movie', query, pathname, callback); return true;
    }
    m = /^\/api\/collection\/([234])$/.exec(pathname);
    if (m) {
      var c = m[1], type = c === '3' ? 'movie' : 'series', title = c === '2' ? 'Популярные сериалы' : c === '3' ? 'Новые фильмы' : 'Новые сериалы';
      listing(type, {sort: c === '2' ? 'popularity' : 'date'}, pathname, callback, title); return true;
    }
    m = /^\/api\/(movies|series)\/(android-(movie|series)-([1-9][0-9]{0,11}))$/.exec(pathname);
    if (m) {
      var expected = m[1] === 'series' ? 'series' : 'movie';
      var explicitSeason = query.season !== undefined && query.season !== null && query.season !== '';
      var season = explicitSeason ? integer(query.season, null, 1, 9999) : null;
      if (m[3] !== expected || explicitSeason && season === null) { callback(failure('Invalid native content route', 400)); return true; }
      details(m[4], expected, season, callback); return true;
    }
    // Preserve saved, non-native URLs and unmodified portal/account endpoints.
    return false;
  }
  return {handle: handle, version: VERSION, stats: function () { return {entries: order.length, bytes: bytes, active: active, queued: queue.length}; }};
}
exports.create = create;
exports.version = VERSION;
exports.card = card;
exports.slug = slug;
exports.rewriteLegacy = rewriteLegacy;
