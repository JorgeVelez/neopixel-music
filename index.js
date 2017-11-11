/*TODO
fix range length doesn't match domain length
ignore tracks with 0 notes
hide option
handle velocities up to 127
scale track max velocity
*/

//config file
var config = require('./config.js');

if(config.songs.length < 1){
    console.log('!!! Error !!!, no songs defined in config.js, config.songs is empty.');
    process.exit(0);
}

//midi parser
var MidiPlayer = require('midi-player-js');
//mp3 player
var player = require('play-sound')(opts = {})
//neopixels
var ws281x = false;
if(process.arch == 'arm'){
    var ws281x = require('rpi-ws281x-native');
}
const CronEmitter = require('cron-emitter');
var parser = require('cron-parser');
var d3 = require("d3");
// Setup express server
var express = require('express');
var app = express();
var path = require('path');
var http = require('http').Server(app);
var io = require('socket.io')(http);
var port = process.env.PORT || config.port;

process.on('SIGINT', function () {
    //reset neopixels
    if(process.arch == 'arm'){
        ws281x.reset();
    }
    //terminate audio
    if(audioPlayer){
        audioPlayer.kill();
    }
    process.nextTick(function () { process.exit(0); });
});

http.listen(port, function(){
  //console.log('listening on *:'+port);
});

// Routing
app.use(express.static(path.join(__dirname, 'public')));

//state
var currentSong = config.songs.length - 1;
var schedulePlay = true;

//init neopixels
if(process.arch == 'arm'){
    ws281x.init(config.numPixels);
}
var pixelData = new Uint32Array(config.numPixels);

var audioPlayer; //audio player
var midiParser = createMidiParser(); //midi parser
midiParser.on('fileLoaded', loadedSong);
midiParser.on('endOfFile', (event) => {
    io.emit('endOfFile', currentSong);
    config.songs[currentSong].playing = false;
    //play next song
    if(currentSong < config.songs.length - 1){
        setTimeout(()=>{
            playSong(currentSong+1);
        }, config.delayBetweenSongs);
    }
});



var analyzedMidis = false;
loadSong(); //start loading each song, last to first and store track scale analyses

//cron schedule
const emitter = new CronEmitter();
emitter.add(config.cron, 'cron');
emitter.on('cron', () => {
    if(schedulePlay){
        var interval = parser.parseExpression(config.cron);
        io.emit('nextRuntime', interval.next());
        //start playing first song, only if not already playing
        if(!midiParser.isPlaying()){
            playSong(0);
        }
    }
});

function setupComplete(){
    //console.log('Setup Complete');
    //web socket events
    io.on('connection', function (socket) {
    
        console.log('Client Connected');
        var interval = parser.parseExpression(config.cron);
        config.nextRuntime = new Date(interval.next());
        
        if(midiParser.isPlaying()){
            config.currentSong = currentSong;
        }
        
        socket.emit('config', config);
        socket.on('play', play);
        socket.on('stop', stop);
        socket.on('playSong', playSong);
        socket.on('disableSchedulePlay', disableSchedulePlay);
    });
}

function playSong(index){
        
    if(currentSong != index){
        //new song, change song and play
        stop();
        currentSong = index;
        isPlaybackReady = false;
        loadSong();
    }else{
        //same song, restart
        stop();
        play();
    }
}

function loadSong(){
    midiParser.loadFile(config.audioPath+config.songs[currentSong].midiFile);
}

function loadedSong(midiParser){
    //analyze midi tracks, recursively load next song in reverse order so first song is ready to play
    if(!analyzedMidis){
        config.songs[currentSong].duration = midiParser.getSongTime();
        console.log('Analyze song', currentSong, config.songs[currentSong].midiFile, Math.round(config.songs[currentSong].duration)+' seconds');        
        analyzeMidi(midiParser, currentSong);
        if(currentSong > 0){
            //analyze the rest of the songs
            loadSong(--currentSong);
        }else{
            analyzedMidis = true;
            setupComplete();
            playbackReady();
        }
    }else{
        console.log('Loaded song', currentSong, config.songs[currentSong].midiFile, Math.round(midiParser.getSongTime())+' seconds');         
        playbackReady();
        play();
    }
}

function playbackReady(){
    isPlaybackReady = true;
}

function disableSchedulePlay(){
    schedulePlay = false;
}

// Initialize player and register event handler
function createMidiParser(){
    return new MidiPlayer.Player(function(event) {
        if(event.name == "Note off" || event.name == "Note on"){

            var song = config.songs[currentSong];
            var trackOptions = song.trackOptions[song.originalTrackOrder[event.track-1]];

            if(!trackOptions.hide){
                var startPixel = trackOptions.scale(event.noteNumber);
                if(song.tracksUseFullWidth){
                    var endPixel = startPixel+trackOptions.segmentSize;
                }else{
                    var endPixel = startPixel+Math.round(song.segmentSize);
                }
     
                var color = 0; //0 is black/off

                if(event.name == "Note on" && event.velocity > 0){
                                
                    var colorObject = d3.color(trackOptions.color);
                    var velocityColor = colorObject.darker((100-event.velocity)/50); //darken color based on note volume
                    var color = rgb2Int(velocityColor.r, velocityColor.g, velocityColor.b);
                }
                
                setPixels(startPixel, endPixel, color);
            }
        } 
    });
}

function setPixels(startPixel, endPixel, color){
    for(var x = startPixel; x < endPixel; x++){
        pixelData[x] = color;
    }
    
    io.emit('pixelData', {pixelData:Array.from(pixelData), percentRemaining: midiParser.getSongPercentRemaining()});
    if(process.arch == 'arm'){
        ws281x.render(pixelData);
    }
}

function play(){

    if(!isPlaybackReady){
        console.log('!!!! PLAYBACK NOT READY !!!!');
        return;
    }

    var delay = 100;
    if(process.arch == 'arm'){
        delay = 800;
    }
    
    setTimeout(function(){
        config.songs[currentSong].midiStartAt && midiParser.skipToSeconds(config.songs[currentSong].midiStartAt);
        if(typeof config.songs[currentSong].midiTempo != 'undefined'){
            midiParser.tempo = config.songs[currentSong].midiTempo;
        }
        midiParser.play();
        console.log('Play midi', config.songs[currentSong].midiFile);
        
        //reenable schedule play and notify front end
        schedulePlay = true;
        var interval = parser.parseExpression(config.cron);
        io.emit('nextRuntime', interval.next());
    }, delay);
    
    
    
    audioPlayer = player.play(config.audioPath+config.songs[currentSong].audioFile, function(err){
      if (err && !err.killed) throw err
    })
    console.log('Play audio', config.songs[currentSong].audioFile);
    io.emit('play', currentSong);
    config.songs[currentSong].playing = true; 
}

function stop(){
    midiParser.stop();
    midiParser.skipToTick(0);
    if(audioPlayer){
        audioPlayer.kill();
    }
    setPixels(0, config.numPixels-1, 0); //set all pixels black/off
    console.log('Stop');
    io.emit('stop', currentSong);
    config.songs[currentSong].playing = false;
}



function analyzeMidi(player, songIndex){

    var song = config.songs[songIndex];
    var trackNests = [];
    var trackNotes = [];
    
    //create config tracks array
    var tracks = [];
        
    //group all notes by track
    player.tracks.forEach(function(track){
        trackNests.push(d3.nest()
            .key(function(d) { return d.name; })
            .key(function(d) { return d.noteNumber; }).sortKeys((a, b)=>{
                var numA = parseInt(a);
                var numB = parseInt(b);
                return numA - numB;
            })
            .entries(track.events))
    });
        
    //store which notes each track contains
    trackNests.forEach((trackNest, i)=>{
        
        trackNotes[i] = [];
        
        var instrument = '';
        
        trackNest.forEach((event)=>{
            if(event.key == "Note on"){
                event.values.forEach((noteNumber)=>{
                    trackNotes[i].push(parseInt(noteNumber.key));
                });
            }else if(event.key == "Sequence/Track Name"){
                var trackNameEvent = event.values[0].values[0];
                //store track instrument in config
                instrument = trackNameEvent.string.trim();
            }
        });
        
        //create track object
        tracks.push({
            name: 'Track'+(i+1),
            index: i, //retain original index which will be resorted by median pitch later so that midi events can be matched up to trackOptions
            instrument: instrument
        });
    });
    
    //calculate track stats
    song.totalNotes = 0; //total number of unique notes in each track, not total number of notes played per song
    trackNotes.forEach((notes, i)=>{
        song.totalNotes += notes.length;
        tracks[i].medianPitch = (notes.length) ? d3.median(notes) : 0; //median pitch
        tracks[i].notes = notes;
    });
        
    //sort tracks by pitch so higher pitch notes show up at end of pixel strip and lower notes show up at other end of pixel strip
    var sortDirection = (config.pitchSort) ? d3[config.pitchSort] : d3.ascending;
    tracks.sort((a,b)=>{
        return sortDirection(a.medianPitch, b.medianPitch);
    });
    song.originalTrackOrder = [];

    //map the domain of possible tract notes to the entire neopixel segment range
    var pixelIndex = 0;    
    
    var segmentSize;
    if(song.tracksUseFullWidth){
        //PIXELS CAN OVERLAP IF MULTIPLE TRACKS PLAY NOTES SIMULTANEOUSLY
        //tracks with few notes have very wide pixel segments, tracks with many notes have narrow segments
    }else{
        //tracks are separated into lanes, guaranteed not to overlap.  all notes have same segment size
        segmentSize = config.numPixels/song.totalNotes; //tracks separated into "lanes" of pixels
    }
    
    
//MERGE WITH CONFIG TRACK OPTIONS HERE to ensure hide value eliminates pixel lane
    /*
    song.trackOptions.forEach((trackOption)=>{
        
    });
    */

    //temp
    song.trackOptions = tracks;
    
    var colorIndex = 0;
    var tracksWithNotes = 0;
    
    song.trackOptions.forEach((trackOptions, i)=>{    
        var notes = trackOptions.notes;        
        trackOptions.numNotes = notes.length;
        
        if(notes.length){
            tracksWithNotes++;
        }
        
        //store original track order from before sorting
        song.originalTrackOrder[trackOptions.index] = i;
        
        //if track has notes, assign next color in config.colors
        if(trackOptions.numNotes){
            trackOptions.color = d3.scaleOrdinal().range(config.colors).domain(d3.range(config.colors.length))(colorIndex++%config.colors.length);
        }

        var range = [];
        
        if(song.tracksUseFullWidth){
            segmentSize = Math.floor(config.numPixels/notes.length);
            trackOptions.segmentSize = segmentSize;
            range = d3.range(0, config.numPixels, segmentSize);
        }else{
            song.segmentSize = segmentSize;
            
            while(range.length < notes.length){
                var pixel = Math.round(pixelIndex*segmentSize);
                range.push(pixel);
                pixelIndex++;
            }
        }
        trackOptions.scale = d3.scaleOrdinal(range).domain(notes);
        trackOptions.range = trackOptions.scale.range();
        trackOptions.domain = trackOptions.scale.domain();
        
    });  
}

function rgb2Int(r, g, b) {
  return ((r & 0xff) << 16) + ((g & 0xff) << 8) + (b & 0xff);
}